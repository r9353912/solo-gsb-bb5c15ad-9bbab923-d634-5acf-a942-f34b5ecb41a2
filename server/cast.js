'use strict';

// 演员归属与走词单
//
// - cast_members：按稿件登记的演员名单；
// - branch_segments.cast_member_id：每个字幕片段至多归属一名演员（NULL=未归属）；
// - 拆分片段沿用原演员；合并相邻片段仅在演员相同时沿用，否则清空归属并提示重新指定；
// - 修改文案/时码、重剪重排不改变归属（重剪重排只更新时码）；
// - 走词单导出：逐条给出演员、时码、台词与原稿来源序号；
//   存在未归属片段或时间线错误时列出具体片段并拒绝整份导出。

const { validateTimeline } = require('./srt');

class CastError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

const NAME_MAX = 60;

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function listCast(db, scriptId) {
  return db.prepare(`
    SELECT id, name, created_at FROM cast_members
    WHERE script_id = ? ORDER BY id
  `).all(scriptId);
}

function createCastMember(db, scriptId, rawName) {
  const name = normalizeName(rawName);
  if (!name) throw new CastError(400, '演员姓名不能为空');
  if (name.length > NAME_MAX) throw new CastError(400, `演员姓名不能超过 ${NAME_MAX} 字`);
  const dup = db.prepare('SELECT id FROM cast_members WHERE script_id = ? AND name = ?').get(scriptId, name);
  if (dup) throw new CastError(409, `演员「${name}」已存在，请勿重复登记`);
  const info = db.prepare(
    'INSERT INTO cast_members (script_id, name) VALUES (?, ?)'
  ).run(scriptId, name);
  return db.prepare('SELECT id, name, created_at FROM cast_members WHERE id = ?').get(info.lastInsertRowid);
}

function renameCastMember(db, scriptId, memberId, rawName) {
  const name = normalizeName(rawName);
  if (!name) throw new CastError(400, '演员姓名不能为空');
  if (name.length > NAME_MAX) throw new CastError(400, `演员姓名不能超过 ${NAME_MAX} 字`);
  const row = db.prepare(
    'SELECT id FROM cast_members WHERE id = ? AND script_id = ?'
  ).get(memberId, scriptId);
  if (!row) throw new CastError(404, '演员不存在');
  const dup = db.prepare(
    'SELECT id FROM cast_members WHERE script_id = ? AND name = ? AND id <> ?'
  ).get(scriptId, name, memberId);
  if (dup) throw new CastError(409, `演员「${name}」已存在，请勿重复登记`);
  db.prepare('UPDATE cast_members SET name = ? WHERE id = ?').run(name, memberId);
  return db.prepare('SELECT id, name, created_at FROM cast_members WHERE id = ?').get(memberId);
}

function deleteCastMember(db, scriptId, memberId) {
  const row = db.prepare(
    'SELECT id, name FROM cast_members WHERE id = ? AND script_id = ?'
  ).get(memberId, scriptId);
  if (!row) throw new CastError(404, '演员不存在');
  // ON DELETE SET NULL：该演员名下片段归属自动清空（成为未归属片段）
  db.prepare('DELETE FROM cast_members WHERE id = ?').run(memberId);
  return { id: memberId, name: row.name };
}

/**
 * 为单个片段指定演员（memberId=null 表示清空归属）。
 * 不触碰文案/时码，因此不推进 rev（质检豁免继续有效）。
 */
function assignCast(db, branchId, segmentId, memberId) {
  const branch = db.prepare('SELECT id, script_id FROM branches WHERE id = ?').get(branchId);
  if (!branch) throw new CastError(404, '分支不存在');
  const seg = db.prepare(
    'SELECT id FROM branch_segments WHERE id = ? AND branch_id = ?'
  ).get(segmentId, branchId);
  if (!seg) throw new CastError(404, '片段不存在');

  if (memberId != null) {
    const m = db.prepare(
      'SELECT id FROM cast_members WHERE id = ? AND script_id = ?'
    ).get(memberId, branch.script_id);
    if (!m) throw new CastError(400, '演员不存在或不属于该稿件，请先在演员名单中登记');
  }
  db.prepare('UPDATE branch_segments SET cast_member_id = ? WHERE id = ?').run(
    memberId == null ? null : memberId,
    segmentId
  );
  return { ok: true, segment_id: segmentId, cast_member_id: memberId == null ? null : memberId };
}

/**
 * 构造当前分支的走词单数据。
 * @returns {{branch, script, lines: Array, unassigned: Array, timeline_issues: Array}}
 */
function buildCueSheet(db, branchId, getSegments) {
  const branch = db.prepare('SELECT id, script_id, name, kind FROM branches WHERE id = ?').get(branchId);
  if (!branch) throw new CastError(404, '分支不存在');
  const script = db.prepare('SELECT id, name FROM scripts WHERE id = ?').get(branch.script_id);
  const segments = getSegments(db, branchId); // 已带 cast_member_id / cast_name / source_ids

  const seqRows = db.prepare('SELECT id, seq FROM source_segments WHERE script_id = ?').all(branch.script_id);
  const seqById = new Map(seqRows.map((r) => [r.id, r.seq]));

  const lines = segments.map((seg) => {
    const sourceSeqs = Array.from(new Set(
      (seg.source_ids || []).map((id) => seqById.get(id)).filter((q) => q != null)
    )).sort((a, b) => a - b);
    return {
      ord: seg.ord,
      cast_member_id: seg.cast_member_id ?? null,
      actor: seg.cast_name ?? null,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      text: seg.text,
      source_seqs: sourceSeqs
    };
  });

  const unassigned = lines
    .filter((l) => l.actor == null)
    .map((l) => ({
      ord: l.ord,
      source_seqs: l.source_seqs,
      start_ms: l.start_ms,
      end_ms: l.end_ms,
      message: `片段 #${l.ord}（原稿来源 ${l.source_seqs.length ? '#' + l.source_seqs.join('/#') : '无'}）尚未归属演员，请先指定演员`
    }));

  const timelineIssues = validateTimeline(segments);
  return { branch, script, lines, unassigned, timeline_issues: timelineIssues };
}

/**
 * 导出前闸门：有未归属片段或时间线错误时抛 409（携带具体片段清单）。
 */
function assertExportable(sheet) {
  if (sheet.unassigned.length || sheet.timeline_issues.length) {
    throw new CastError(
      409,
      `走词单导出被拒绝：${sheet.unassigned.length} 条片段未归属演员，${sheet.timeline_issues.length} 处时间线错误，请先逐条处理`,
      { unassigned: sheet.unassigned, timeline_issues: sheet.timeline_issues }
    );
  }
}

// ---------------- TSV 序列化（Excel 可直接打开，UTF-8 BOM） ----------------

function tsvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[\t\n\r"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 走词单 TSV：逐条给出演员、时码、台词、原稿来源序号。
 */
function toTsv(sheet) {
  const header = ['序号', '演员', '起', '止', '台词', '原稿来源序号'];
  const rows = sheet.lines.map((l, i) => [
    i + 1,
    l.actor || '',
    fmtTc(l.start_ms),
    fmtTc(l.end_ms),
    l.text,
    l.source_seqs.join(',')
  ]);
  const body = [header, ...rows].map((r) => r.map(tsvCell).join('\t')).join('\r\n');
  return '\uFEFF' + body + '\r\n';
}

function fmtTc(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const x = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${x}`;
}

module.exports = {
  CastError,
  listCast,
  createCastMember,
  renameCastMember,
  deleteCastMember,
  assignCast,
  buildCueSheet,
  assertExportable,
  toTsv
};
