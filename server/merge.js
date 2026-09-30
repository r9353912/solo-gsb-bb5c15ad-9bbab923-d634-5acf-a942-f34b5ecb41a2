'use strict';

// 按来源片段的三方合并
//
// 每个分支相对原稿构成一组「区块」，区块按来源序号有序切分：
//   - 普通区块：1 个来源 -> 1 个分支片段
//   - 拆分区块：1 个来源 -> 多个分支片段
//   - 合并区块：多个来源 -> 1 个分支片段
// 遍历来源序号 1..N，对比两条分支在同一区间的区块：
//   只有一方改动            -> 直接采用该方
//   双方都触及同一来源区间  -> 冲突，展示双方内容由用户选择
//   双方均未改              -> 保留原稿

/**
 * 取某分支的片段及其来源 seq，按 ord 排序。
 */
function getBranchSegments(db, branchId) {
  return db.prepare(`
    SELECT bs.id, bs.ord, bs.start_ms, bs.end_ms, bs.text,
           GROUP_CONCAT(ss.source_id) AS source_ids
    FROM branch_segments bs
    LEFT JOIN segment_sources ss ON ss.branch_segment_id = bs.id
    WHERE bs.branch_id = ?
    GROUP BY bs.id
    ORDER BY bs.ord
  `).all(branchId).map((row) => ({
    id: row.id,
    ord: row.ord,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    text: row.text,
    source_ids: row.source_ids ? row.source_ids.split(',').map(Number) : []
  }));
}

function getSources(db, scriptId) {
  return db.prepare(`
    SELECT id, seq, start_ms, end_ms, text
    FROM source_segments WHERE script_id = ? ORDER BY seq
  `).all(scriptId);
}

function segEqualOriginal(seg, src) {
  return seg.start_ms === src.start_ms && seg.end_ms === src.end_ms && seg.text === src.text;
}

/**
 * 由分支片段构造区块列表。
 * 区块：{lo,hi,segments,changed}
 * 约定：正常编辑/拆分时每个片段带来源；合并后可能出现一个片段挂多个来源。
 */
function buildBlocks(segments, srcBySeq) {
  // 规则：按分支片段顺序，相邻片段只要共享任一来源即属于同一区块，
  // 传递合并。这样拆分（[2] [2]）、合并（[2,3]）以及拆分后再跨界合并
  // （[2] [2,3]）都能得到互不重叠、恰好覆盖各自片段的区块。
  const blocks = [];
  for (const seg of segments) {
    const seqs = seg.source_ids
      .map((id) => srcBySeq.idToSeq.get(id))
      .filter((s) => s != null)
      .sort((a, b) => a - b);
    if (!seqs.length) continue;

    const last = blocks[blocks.length - 1];
    if (last && seqs.some((q) => last.srcSet.has(q))) {
      last.segments.push(seg);
      seqs.forEach((q) => last.srcSet.add(q));
      last.lo = Math.min(last.lo, seqs[0]);
      last.hi = Math.max(last.hi, seqs[seqs.length - 1]);
      last.changed = last.changed || !segUnchangedSingle(seg, srcBySeq.map.get(seqs[0]));
      continue;
    }

    blocks.push({
      lo: seqs[0],
      hi: seqs[seqs.length - 1],
      srcSet: new Set(seqs),
      segments: [seg],
      changed: !(seqs.length === 1 && segUnchangedSingle(seg, srcBySeq.map.get(seqs[0])))
    });
  }
  return blocks;
}

function segUnchangedSingle(seg, src) {
  return !!src && seg.source_ids.length === 1 && segEqualOriginal(seg, src);
}

function segPayload(seg, srcBySeq) {
  return {
    branch_segment_id: seg.id,
    start_ms: seg.start_ms,
    end_ms: seg.end_ms,
    text: seg.text,
    sources: seg.source_ids
      .map((id) => srcBySeq.idToSeq.get(id))
      .filter((s) => s != null)
      .sort((a, b) => a - b)
  };
}

/**
 * 计算合并预览。
 * @param {object} opts {scriptId, branchAId, branchBId, nameA, nameB}
 * @returns {{entries: Array, conflictCount:number, sourceCount:number}}
 */
function previewMerge(db, opts) {
  const sources = getSources(db, opts.scriptId);
  const srcBySeq = {
    map: new Map(sources.map((s) => [s.seq, s])),
    idToSeq: new Map(sources.map((s) => [s.id, s.seq]))
  };
  const segA = getBranchSegments(db, opts.branchAId);
  const segB = getBranchSegments(db, opts.branchBId);
  const blocksA = buildBlocks(segA, srcBySeq);
  const blocksB = buildBlocks(segB, srcBySeq);

  const ofA = new Map(); // seq -> block
  const ofB = new Map();
  for (const b of blocksA) for (let s = b.lo; s <= b.hi; s++) ofA.set(s, b);
  for (const b of blocksB) for (let s = b.lo; s <= b.hi; s++) ofB.set(s, b);

  // 1) 用双方区块边界把来源轴切成原子区间，并标注每段：
  //    'A' 仅 A 改动 / 'B' 仅 B 改动 / 'X' 双方都改（冲突）/ '=' 未改动
  const N = sources.length;
  const labelOf = new Map();
  for (let s = 1; s <= N; s++) {
    const ba = ofA.get(s);
    const bb = ofB.get(s);
    const aChanged = !!(ba && ba.changed);
    const bChanged = !!(bb && bb.changed);
    labelOf.set(s, aChanged && bChanged ? 'X' : aChanged ? 'A' : bChanged ? 'B' : '=');
  }

  // 2) 以连续的 X 段为种子，把所有与之相交的结构块（拆分/合并产生）
  //    整体并入冲突区间并反复扩展，再合并相交区间。
  const conflictRanges = [];
  let s = 1;
  while (s <= N) {
    if (labelOf.get(s) !== 'X') { s += 1; continue; }
    let lo = s, hi = s;
    while (hi + 1 <= N && labelOf.get(hi + 1) === 'X') hi += 1;
    let grown = true;
    while (grown) {
      grown = false;
      for (const b of blocksA) {
        if (b.lo <= hi && b.hi >= lo && (b.lo < lo || b.hi > hi)) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); grown = true; }
      }
      for (const b of blocksB) {
        if (b.lo <= hi && b.hi >= lo && (b.lo < lo || b.hi > hi)) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); grown = true; }
      }
    }
    conflictRanges.push([lo, hi]);
    s = hi + 1;
  }
  const mergedRanges = [];
  for (const [lo, hi] of conflictRanges.sort((a, b) => a[0] - b[0])) {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else mergedRanges.push([lo, hi]);
  }
  const inConflict = (seq) => mergedRanges.some(([lo, hi]) => seq >= lo && seq <= hi);

  // 3) 顺次输出：冲突区间整体输出（双方完整内容）；其余按连续标签输出。
  //    与冲突区间相交的结构块已全部归入冲突条目，区间外不存在跨界块。
  const entries = [];
  let conflictIndex = 0;
  let cur = 1;
  while (cur <= N) {
    if (inConflict(cur)) {
      const range = mergedRanges.find((r) => r[0] <= cur && r[1] >= cur);
      const lo = range[0];
      const hi = range[1];
      const aBlocks = collectBlocks(blocksA, lo, hi);
      const bBlocks = collectBlocks(blocksB, lo, hi);
      entries.push({
        type: 'conflict',
        conflict_index: conflictIndex++,
        source_start: lo,
        source_end: hi,
        side_a: {
          branch_id: opts.branchAId, branch_name: opts.nameA,
          segments: aBlocks.flatMap((b) => b.segments).map((g) => segPayload(g, srcBySeq))
        },
        side_b: {
          branch_id: opts.branchBId, branch_name: opts.nameB,
          segments: bBlocks.flatMap((b) => b.segments).map((g) => segPayload(g, srcBySeq))
        }
      });
      cur = hi + 1;
      continue;
    }

    const label = labelOf.get(cur);
    let hi = cur;
    while (hi + 1 <= N && !inConflict(hi + 1) && labelOf.get(hi + 1) === label) hi += 1;

    if (label === 'A' || label === 'B') {
      const blocks = (label === 'A' ? blocksA : blocksB).filter((b) => b.lo >= cur && b.hi <= hi);
      entries.push({
        type: label === 'A' ? 'a_only' : 'b_only',
        source_start: cur, source_end: hi,
        segments: blocks.flatMap((b) => b.segments).map((g) => segPayload(g, srcBySeq))
      });
    } else {
      const segs = [];
      for (let q = cur; q <= hi; q++) segs.push(origPayload(srcBySeq.map.get(q)));
      entries.push({ type: 'unchanged', source_start: cur, source_end: hi, segments: segs });
    }
    cur = hi + 1;
  }

  return {
    entries,
    conflictCount: conflictIndex,
    sourceCount: N,
    sources: sources.map((x) => ({ seq: x.seq, start_ms: x.start_ms, end_ms: x.end_ms, text: x.text }))
  };
}

function collectBlocks(blocks, lo, hi) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    if (b.lo <= hi && b.hi >= lo && !seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

function origPayload(src) {
  return {
    branch_segment_id: null,
    start_ms: src.start_ms,
    end_ms: src.end_ms,
    text: src.text,
    sources: [src.seq]
  };
}

/**
 * 按用户对冲突的选择实际创建合并分支。
 * @param resolutions Map<conflictIndex, 'A'|'B'>
 * @returns branchId
 */
function applyMerge(db, opts, resolutions) {
  const preview = previewMerge(db, opts);
  const unresolved = [];
  for (const e of preview.entries) {
    if (e.type === 'conflict') {
      const choice = resolutions.get(e.conflict_index);
      if (choice !== 'A' && choice !== 'B') unresolved.push(e.conflict_index);
    }
  }
  if (unresolved.length) {
    const err = new Error(`尚有 ${unresolved.length} 处冲突未选择处理方式`);
    err.statusCode = 400;
    err.unresolved = unresolved;
    throw err;
  }

  const result = db.transaction(() => {
    const branchInfo = db.prepare(`
      INSERT INTO branches (script_id, name, kind) VALUES (?, ?, 'merged')
    `).run(opts.scriptId, opts.mergedName);
    const branchId = branchInfo.lastInsertRowid;

    const insSeg = db.prepare(
      'INSERT INTO branch_segments (branch_id, ord, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
    );
    const insLink = db.prepare(
      'INSERT INTO segment_sources (branch_segment_id, source_id) VALUES (?, ?)'
    );
    const sourceRows = db.prepare(
      'SELECT id, seq FROM source_segments WHERE script_id = ?'
    ).all(opts.scriptId);
    const seqToId = new Map(sourceRows.map((r) => [r.seq, r.id]));

    let ord = 1;
    for (const e of preview.entries) {
      let segs;
      if (e.type === 'conflict') {
        segs = resolutions.get(e.conflict_index) === 'A' ? e.side_a.segments : e.side_b.segments;
      } else {
        segs = e.segments;
      }
      for (const g of segs) {
        const r = insSeg.run(branchId, ord++, g.start_ms, g.end_ms, g.text);
        if (g.sources && g.sources.length) {
          for (const seq of g.sources) insLink.run(r.lastInsertRowid, seqToId.get(seq));
        } else {
          for (let q = e.source_start; q <= e.source_end; q++) {
            insLink.run(r.lastInsertRowid, seqToId.get(q));
          }
        }
      }
    }
    return branchId;
  })();

  return { branchId: result, preview };
}

module.exports = { previewMerge, applyMerge, getBranchSegments, getSources };
