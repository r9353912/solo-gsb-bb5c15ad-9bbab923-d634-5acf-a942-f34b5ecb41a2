'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { parseSrt, validateTimeline, toSrt, msToSrt } = require('./srt');
const { previewMerge, applyMerge, getBranchSegments } = require('./merge');
const qc = require('./qc');
const recut = require('./recut');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function httpError(status, message, extra) {
  const err = new Error(message);
  err.statusCode = status;
  Object.assign(err, extra || {});
  return err;
}

// ---------------- 稿件 ----------------

// 列表
app.get('/api/scripts', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.created_at,
           (SELECT COUNT(*) FROM source_segments x WHERE x.script_id = s.id) AS segment_count,
           (SELECT COUNT(*) FROM branches b WHERE b.script_id = s.id) AS branch_count
    FROM scripts s ORDER BY s.id DESC
  `).all();
  res.json(rows);
});

// 导入 SRT：任何格式/时间码错误都拒绝整份稿件
app.post('/api/scripts', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, '未收到上传文件');
    const name = (req.body.name || req.file.originalname || '未命名稿件').replace(/\.srt$/i, '');
    const raw = req.file.buffer.toString('utf8');
    const { cues, errors } = parseSrt(raw);

    if (errors.length) {
      throw httpError(400, `SRT 校验失败，共 ${errors.length} 处错误，已拒绝整份稿件`, { errors });
    }

    const scriptId = db.transaction(() => {
      const info = db.prepare('INSERT INTO scripts (name, original_srt) VALUES (?, ?)').run(name, raw);
      const sid = info.lastInsertRowid;
      const insSrc = db.prepare(
        'INSERT INTO source_segments (script_id, seq, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
      );
      cues.forEach((c, idx) => insSrc.run(sid, idx + 1, c.start_ms, c.end_ms, c.text));

      // 从同一原稿建立两条修订分支（默认分支）
      const insBranch = db.prepare('INSERT INTO branches (script_id, name, kind) VALUES (?, ?, ?)');
      const insSeg = db.prepare(
        'INSERT INTO branch_segments (branch_id, ord, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
      );
      const insLink = db.prepare(
        'INSERT INTO segment_sources (branch_segment_id, source_id) VALUES (?, ?)'
      );
      const sources = db.prepare(
        'SELECT id FROM source_segments WHERE script_id = ? ORDER BY seq'
      ).all(sid);

      for (const branchName of ['修订分支 A', '修订分支 B']) {
        const bid = insBranch.run(sid, branchName, 'revision').lastInsertRowid;
        cues.forEach((c, idx) => {
          const segId = insSeg.run(bid, idx + 1, c.start_ms, c.end_ms, c.text).lastInsertRowid;
          insLink.run(segId, sources[idx].id);
        });
      }
      return sid;
    })();

    res.status(201).json({ id: scriptId, name, segment_count: cues.length });
  } catch (e) {
    next(e);
  }
});

// 稿件详情：原稿片段 + 分支列表
app.get('/api/scripts/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const script = db.prepare('SELECT id, name, created_at, original_srt FROM scripts WHERE id = ?').get(id);
    if (!script) throw httpError(404, '稿件不存在');
    const sources = db.prepare(
      'SELECT id, seq, start_ms, end_ms, text FROM source_segments WHERE script_id = ? ORDER BY seq'
    ).all(id);
    const branches = db.prepare(
      "SELECT id, name, kind, created_at FROM branches WHERE script_id = ? ORDER BY id"
    ).all(id);
    res.json({ ...script, sources, branches });
  } catch (e) {
    next(e);
  }
});

// 删除稿件（级联删除片段与分支）
app.delete('/api/scripts/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const info = db.prepare('DELETE FROM scripts WHERE id = ?').run(id);
    if (!info.changes) throw httpError(404, '稿件不存在');
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 查看原稿（原始 SRT 文本）
app.get('/api/scripts/:id/original', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const script = db.prepare('SELECT name, original_srt FROM scripts WHERE id = ?').get(id);
    if (!script) throw httpError(404, '稿件不存在');
    res.type('text/plain; charset=utf-8').send(script.original_srt);
  } catch (e) {
    next(e);
  }
});

// 下载原稿 SRT
app.get('/api/scripts/:id/original.srt', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const script = db.prepare('SELECT name, original_srt FROM scripts WHERE id = ?').get(id);
    if (!script) throw httpError(404, '稿件不存在');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${script.name}-原稿.srt`)}`);
    res.type('application/x-subrip; charset=utf-8').send(script.original_srt);
  } catch (e) {
    next(e);
  }
});

// ---------------- 分支 ----------------

function getBranchOr404(branchId) {
  const b = db.prepare('SELECT id, script_id, name, kind FROM branches WHERE id = ?').get(branchId);
  if (!b) throw httpError(404, '分支不存在');
  return b;
}

app.get('/api/branches/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const branch = getBranchOr404(id);
    const segments = getBranchSegments(db, id);
    res.json({ ...branch, segments });
  } catch (e) {
    next(e);
  }
});

app.patch('/api/branches/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    getBranchOr404(id);
    const name = (req.body.name || '').trim();
    if (!name) throw httpError(400, '分支名称不能为空');
    db.prepare('UPDATE branches SET name = ? WHERE id = ?').run(name, id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

function readMs(body, key) {
  const v = body[key];
  if (!Number.isInteger(v) || v < 0) throw httpError(400, `${key} 必须为非负整数毫秒`);
  return v;
}

// 修改单个片段的文案 / 起止时间
app.patch('/api/branches/:id/segments/:sid', (req, res, next) => {
  try {
    const branchId = parseInt(req.params.id, 10);
    const segId = parseInt(req.params.sid, 10);
    getBranchOr404(branchId);
    const seg = db.prepare(
      'SELECT id, ord, start_ms, end_ms, text FROM branch_segments WHERE id = ? AND branch_id = ?'
    ).get(segId, branchId);
    if (!seg) throw httpError(404, '片段不存在');

    const fields = [];
    const values = [];
    let changed = false;
    if (req.body.start_ms !== undefined) {
      const v = readMs(req.body, 'start_ms');
      if (v !== seg.start_ms) changed = true;
      fields.push('start_ms = ?'); values.push(v);
    }
    if (req.body.end_ms !== undefined) {
      const v = readMs(req.body, 'end_ms');
      if (v !== seg.end_ms) changed = true;
      fields.push('end_ms = ?'); values.push(v);
    }
    if (req.body.text !== undefined) {
      if (typeof req.body.text !== 'string') throw httpError(400, 'text 必须为字符串');
      if (req.body.text !== seg.text) changed = true;
      fields.push('text = ?');
      values.push(req.body.text);
    }
    if (!fields.length) throw httpError(400, '没有需要更新的字段');

    // 文案/时码任一实质变化即推进片段修订计数，使按片段绑定的质检豁免失效
    if (changed) { fields.push('rev = rev + 1'); }
    values.push(segId);
    db.prepare(`UPDATE branch_segments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true, rev_bumped: changed });
  } catch (e) {
    next(e);
  }
});

// 拆分片段：cut_ms 为切点，把片段切成 [start,cut] 与 [cut,end] 两条，均继承同一来源
app.post('/api/branches/:id/segments/:sid/split', (req, res, next) => {
  try {
    const branchId = parseInt(req.params.id, 10);
    getBranchOr404(branchId);
    const segId = parseInt(req.params.sid, 10);
    const cut = readMs(req.body, 'cut_ms');

    const seg = db.prepare(
      'SELECT id, ord, start_ms, end_ms, text, rev FROM branch_segments WHERE id = ? AND branch_id = ?'
    ).get(segId, branchId);
    if (!seg) throw httpError(404, '片段不存在');
    if (!(cut > seg.start_ms && cut < seg.end_ms)) {
      throw httpError(400, `切点必须严格位于起止时间之间（${msToSrt(seg.start_ms)} ~ ${msToSrt(seg.end_ms)}）`);
    }

    db.transaction(() => {
      db.prepare('UPDATE branch_segments SET ord = ord + 1 WHERE branch_id = ? AND ord > ?').run(branchId, seg.ord);
      // 切点/边界变化：两条都视为新修订，旧豁免不得沿用
      db.prepare('UPDATE branch_segments SET end_ms = ?, ord = ?, rev = rev + 1 WHERE id = ?')
        .run(cut, seg.ord, segId);
      const newId = db.prepare(
        'INSERT INTO branch_segments (branch_id, ord, start_ms, end_ms, text, rev) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(branchId, seg.ord + 1, cut, seg.end_ms, seg.text, seg.rev + 1).lastInsertRowid;
      const links = db.prepare(
        'SELECT source_id FROM segment_sources WHERE branch_segment_id = ?'
      ).all(segId);
      const ins = db.prepare('INSERT INTO segment_sources (branch_segment_id, source_id) VALUES (?, ?)');
      links.forEach((l) => ins.run(newId, l.source_id));
    })();

    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 合并相邻片段：把指定片段与下一片段合并为一条，来源取并集，时间取外边界
app.post('/api/branches/:id/segments/:sid/merge-with-next', (req, res, next) => {
  try {
    const branchId = parseInt(req.params.id, 10);
    getBranchOr404(branchId);
    const segId = parseInt(req.params.sid, 10);
    const seg = db.prepare(
      'SELECT id, ord, start_ms, end_ms, text FROM branch_segments WHERE id = ? AND branch_id = ?'
    ).get(segId, branchId);
    if (!seg) throw httpError(404, '片段不存在');
    const next = db.prepare(
      'SELECT id, ord, start_ms, end_ms, text FROM branch_segments WHERE branch_id = ? AND ord = ?'
    ).get(branchId, seg.ord + 1);
    if (!next) throw httpError(400, '该片段已经是最后一条，无法与下一片段合并');

    const joiner = req.body && typeof req.body.joiner === 'string' ? req.body.joiner : ' ';
    const mergedText = `${seg.text}${joiner}${next.text}`;

    db.transaction(() => {
      const srcs = db.prepare(`
        SELECT source_id FROM segment_sources
        WHERE branch_segment_id IN (?, ?)
        GROUP BY source_id
      `).all(segId, next.id);
      db.prepare('DELETE FROM segment_sources WHERE branch_segment_id IN (?, ?)').run(segId, next.id);
      db.prepare('DELETE FROM branch_segments WHERE id = ?').run(next.id);
      // 合并后文案/时码均可能变化：推进保留片段的修订计数，旧豁免失效
      db.prepare('UPDATE branch_segments SET start_ms = ?, end_ms = ?, text = ?, rev = rev + 1 WHERE id = ?')
        .run(Math.min(seg.start_ms, next.start_ms), Math.max(seg.end_ms, next.end_ms), mergedText, segId);
      const ins = db.prepare('INSERT INTO segment_sources (branch_segment_id, source_id) VALUES (?, ?)');
      srcs.forEach((x) => ins.run(segId, x.source_id));
      db.prepare('UPDATE branch_segments SET ord = ord - 1 WHERE branch_id = ? AND ord > ?')
        .run(branchId, next.ord);
    })();

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 将分支片段恢复为原稿内容（按其来源；若一个片段挂多个来源则恢复为第一条来源）
app.post('/api/branches/:id/segments/:sid/reset', (req, res, next) => {
  try {
    const branchId = parseInt(req.params.id, 10);
    getBranchOr404(branchId);
    const segId = parseInt(req.params.sid, 10);
    const row = db.prepare(`
      SELECT ss.source_id, src.start_ms, src.end_ms, src.text
      FROM segment_sources ss
      JOIN source_segments src ON src.id = ss.source_id
      WHERE ss.branch_segment_id = ?
      ORDER BY src.seq LIMIT 1
    `).get(segId);
    if (!row) throw httpError(400, '该片段找不到对应原稿来源，无法恢复');
    const cur = db.prepare('SELECT start_ms, end_ms, text FROM branch_segments WHERE id = ?').get(segId);
    const changed = !cur || cur.start_ms !== row.start_ms || cur.end_ms !== row.end_ms || cur.text !== row.text;
    db.prepare(
      changed
        ? 'UPDATE branch_segments SET start_ms = ?, end_ms = ?, text = ?, rev = rev + 1 WHERE id = ?'
        : 'UPDATE branch_segments SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?'
    ).run(row.start_ms, row.end_ms, row.text, segId);
    res.json({ ok: true, rev_bumped: changed });
  } catch (e) {
    next(e);
  }
});

// 整条分支重置回原稿
app.post('/api/branches/:id/reset-all', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const branch = getBranchOr404(id);
    if (branch.kind === 'merged') throw httpError(400, '合并结果分支不可整体重置');
    db.transaction(() => {
      db.prepare('DELETE FROM segment_sources WHERE branch_segment_id IN (SELECT id FROM branch_segments WHERE branch_id = ?)').run(id);
      db.prepare('DELETE FROM branch_segments WHERE branch_id = ?').run(id);
      const sources = db.prepare(
        'SELECT id, start_ms, end_ms, text FROM source_segments WHERE script_id = ? ORDER BY seq'
      ).all(branch.script_id);
      const insSeg = db.prepare(
        'INSERT INTO branch_segments (branch_id, ord, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
      );
      const insLink = db.prepare(
        'INSERT INTO segment_sources (branch_segment_id, source_id) VALUES (?, ?)'
      );
      sources.forEach((s, i) => {
        const segId = insSeg.run(id, i + 1, s.start_ms, s.end_ms, s.text).lastInsertRowid;
        insLink.run(segId, s.id);
      });
    })();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------- 合并 ----------------

// 合并预览：按来源片段识别改动，冲突列出双方内容
app.post('/api/merge/preview', (req, res, next) => {
  try {
    const branchAId = parseInt(req.body.branch_a_id, 10);
    const branchBId = parseInt(req.body.branch_b_id, 10);
    if (!Number.isInteger(branchAId) || !Number.isInteger(branchBId)) {
      throw httpError(400, '需要提供 branch_a_id 与 branch_b_id');
    }
    if (branchAId === branchBId) throw httpError(400, '请选择两条不同的分支');
    const a = getBranchOr404(branchAId);
    const b = getBranchOr404(branchBId);
    if (a.script_id !== b.script_id) throw httpError(400, '两条分支必须来自同一份原稿');

    const result = previewMerge(db, {
      scriptId: a.script_id,
      branchAId, branchBId,
      nameA: a.name, nameB: b.name
    });
    res.json({ branch_a: { id: a.id, name: a.name }, branch_b: { id: b.id, name: b.name }, ...result });
  } catch (e) {
    next(e);
  }
});

// 执行合并：必须为每个冲突指定 A 或 B，未冲突改动自动保留
app.post('/api/merge/apply', (req, res, next) => {
  try {
    const branchAId = parseInt(req.body.branch_a_id, 10);
    const branchBId = parseInt(req.body.branch_b_id, 10);
    const a = getBranchOr404(branchAId);
    const b = getBranchOr404(branchBId);
    if (a.script_id !== b.script_id) throw httpError(400, '两条分支必须来自同一份原稿');

    const raw = req.body.resolutions;
    if (!raw || typeof raw !== 'object') throw httpError(400, '需要 resolutions 映射（冲突序号 -> "A"/"B"）');
    const resolutions = new Map();
    for (const [k, v] of Object.entries(raw)) {
      const idx = parseInt(k, 10);
      if (!Number.isInteger(idx) || (v !== 'A' && v !== 'B')) {
        throw httpError(400, `冲突 ${k} 的选择必须为 "A" 或 "B"`);
      }
      resolutions.set(idx, v);
    }

    const mergedName = (req.body.merged_name || `合并结果 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`).trim();
    const { branchId } = applyMerge(db, {
      scriptId: a.script_id,
      branchAId, branchBId,
      nameA: a.name, nameB: b.name,
      mergedName
    }, resolutions);

    res.status(201).json({ id: branchId, name: mergedName });
  } catch (e) {
    next(e);
  }
});

// ---------------- 重剪重排 ----------------

// 预览：选择连续来源序号区间并指定其在新版视频中的起止时码，
// 返回每条受影响片段的新旧时码、换算问题、时间线问题与一次性预览令牌。
app.post('/api/branches/:id/recut/preview', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    getBranchOr404(id);
    const preview = recut.previewRecut(db, id, req.body || {}, getBranchSegments);
    res.json(preview);
  } catch (e) {
    next(e);
  }
});

// 确认提交：令牌须与当前分支状态及参数一致，否则 409 要求重新预览；
// 单事务写库，整体成功或不改动，仅时码实际变化的片段推进 rev。
app.post('/api/branches/:id/recut/apply', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    getBranchOr404(id);
    const result = recut.applyRecut(db, id, req.body || {}, getBranchSegments);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------------- 导出 ----------------

// 导出前检查
app.get('/api/branches/:id/validate', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    getBranchOr404(id);
    const segments = getBranchSegments(db, id);
    const issues = validateTimeline(segments);
    res.json({ ok: issues.length === 0, issues });
  } catch (e) {
    next(e);
  }
});

// 导出序号连续的 SRT；校验失败不生成文件
app.get('/api/branches/:id/export', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const branch = getBranchOr404(id);
    const segments = getBranchSegments(db, id);
    const issues = validateTimeline(segments);
    if (issues.length) {
      throw httpError(409, `时间线校验失败，共 ${issues.length} 处问题，未生成文件`, { issues });
    }
    const script = db.prepare('SELECT name FROM scripts WHERE id = ?').get(branch.script_id);
    const body = toSrt(segments);
    const fname = `${script.name}-${branch.name}.srt`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.type('application/x-subrip; charset=utf-8').send(body);
  } catch (e) {
    next(e);
  }
});

// ---------------- 放映质检 ----------------

// 读取稿件的当前质检规则（未配置时返回 configured:false）
app.get('/api/scripts/:id/qc-rules', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const script = db.prepare('SELECT id FROM scripts WHERE id = ?').get(id);
    if (!script) throw httpError(404, '稿件不存在');
    const row = qc.getCurrentRulesRow(db, id);
    res.json({
      script_id: id,
      configured: !!row,
      rules: row ? qc.rulesRowToApi(row) : null
    });
  } catch (e) {
    next(e);
  }
});

// 保存质检规则；无效阈值、空词或重复词拒绝保存（不产生新版本）
app.put('/api/scripts/:id/qc-rules', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const script = db.prepare('SELECT id FROM scripts WHERE id = ?').get(id);
    if (!script) throw httpError(404, '稿件不存在');

    const { values, errors } = qc.normalizeRuleInput(req.body || {});
    if (errors.length) {
      throw httpError(400, `质检规则校验失败，共 ${errors.length} 处问题，已拒绝保存`, { qc_errors: errors });
    }

    const result = qc.saveRules(db, id, values);
    res.status(result.changed ? 201 : 200).json({
      ok: true,
      changed: result.changed,
      rules: qc.rulesRowToApi(qc.getCurrentRulesRow(db, id))
    });
  } catch (e) {
    next(e);
  }
});

// 生成质检报告（按当前文字与时码；拆分/合并/编辑后须重新生成）
app.post('/api/branches/:id/qc/reports', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    getBranchOr404(id);
    const report = qc.generateReport(db, id, getBranchSegments);
    res.status(201).json(report);
  } catch (e) {
    next(e);
  }
});

// 查看最新报告（含失效标记与豁免状态）
app.get('/api/branches/:id/qc/reports/latest', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    getBranchOr404(id);
    const report = qc.getLatestReport(db, id, getBranchSegments);
    if (!report) return res.json({ exists: false });
    res.json({ exists: true, report });
  } catch (e) {
    next(e);
  }
});

// 查看指定报告
app.get('/api/qc/reports/:rid', (req, res, next) => {
  try {
    const rid = parseInt(req.params.rid, 10);
    res.json(qc.getReport(db, rid, getBranchSegments));
  } catch (e) {
    next(e);
  }
});

// 对某条命中填写豁免理由
app.post('/api/branches/:id/qc/hits/:hid/exempt', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const hid = parseInt(req.params.hid, 10);
    getBranchOr404(id);
    const reason = req.body && req.body.reason;
    const report = qc.grantExemption(db, id, hid, reason, getBranchSegments);
    res.status(201).json({ ok: true, report });
  } catch (e) {
    next(e);
  }
});

// 撤销豁免
app.delete('/api/branches/:id/qc/exemptions/:eid', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const eid = parseInt(req.params.eid, 10);
    getBranchOr404(id);
    const report = qc.revokeExemption(db, id, eid, getBranchSegments);
    res.json({ ok: true, report });
  } catch (e) {
    next(e);
  }
});

// 质检专用下载：实时重新核验分支、规则、豁免与时间线；不通过不生成 SRT
app.get('/api/branches/:id/qc/export', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { branch, segments } = qc.checkGate(db, id, getBranchSegments);
    const script = db.prepare('SELECT name FROM scripts WHERE id = ?').get(branch.script_id);
    const body = toSrt(segments);
    const fname = `${script.name}-${branch.name}-质检通过.srt`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.type('application/x-subrip; charset=utf-8').send(body);
  } catch (e) {
    next(e);
  }
});

// ---------------- 错误处理 ----------------

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  const status = err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || '服务器内部错误',
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.issues ? { issues: err.issues } : {}),
    ...(err.unresolved ? { unresolved: err.unresolved } : {}),
    ...(err.qc_errors ? { qc_errors: err.qc_errors } : {}),
    ...(err.timeline_issues ? { timeline_issues: err.timeline_issues } : {}),
    ...(err.unresolved_hits ? { unresolved_hits: err.unresolved_hits } : {}),
    ...(err.invalid_exemptions ? { invalid_exemptions: err.invalid_exemptions } : {}),
    ...(err.report_stale != null ? { report_stale: err.report_stale } : {}),
    ...(err.recut_errors ? { recut_errors: err.recut_errors } : {}),
    ...(err.preview_stale != null ? { preview_stale: err.preview_stale } : {})
  });
});

app.listen(PORT, HOST, () => {
  console.log(`排练字幕修订应用已启动: http://localhost:${PORT}`);
});
