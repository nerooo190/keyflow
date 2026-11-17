// Note-level accuracy of a transcription against a reference (e.g. a Songscription MIDI/MusicXML export),
// following the MIREX/mir_eval convention: a note is correct if the pitch matches and the onset is within ±50 ms.
// Global time offset and small tempo differences between the files are aligned automatically.

/** Greedy one-to-one matching; returns number of matched notes. */
function matchCount(est, ref, tol, scale = 1, offset = 0) {
  const byPitch = new Map();
  for (const r of ref) { if (!byPitch.has(r.p)) byPitch.set(r.p, []); byPitch.get(r.p).push(r.t); }
  for (const a of byPitch.values()) a.sort((x, y) => x - y);
  const used = new Map();
  let hits = 0, err = 0;
  for (const e of est) {
    const list = byPitch.get(e.p);
    if (!list) continue;
    const t = e.t * scale + offset;
    let lo = 0, hi = list.length - 1, best = -1, bd = tol;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m] < t - tol) lo = m + 1; else hi = m - 1; }
    const u = used.get(e.p) || new Set();
    for (let i = lo; i < list.length && list[i] <= t + tol; i++) {
      const d = Math.abs(list[i] - t);
      if (!u.has(i) && d <= bd) { bd = d; best = i; }
    }
    if (best >= 0) { u.add(best); used.set(e.p, u); hits++; err += bd; }
  }
  return { hits, err };
}

/**
 * @param {Array<{p:number,t:number}>} est  Keyflow notes
 * @param {Array<{p:number,t:number}>} ref  reference notes
 * @returns {{precision, recall, f1, pitchClassF1, offset, scale, matched, est, ref, meanOnsetErrorMs}}
 */
export function compare(est, ref, { tol = 0.05 } = {}) {
  if (!est.length || !ref.length) return { precision: 0, recall: 0, f1: 0, matched: 0, est: est.length, ref: ref.length };
  // coarse alignment: try offsets (-5…5 s) and tempo scales (0.9…1.1) with a loose tolerance, then refine
  let best = { hits: -1, scale: 1, offset: 0 };
  const e0 = Math.min(...est.map((n) => n.t)), r0 = Math.min(...ref.map((n) => n.t));
  for (let scale = 0.9; scale <= 1.1001; scale += 0.005) {
    for (let off = -5; off <= 5; off += 0.05) {
      const offset = r0 - e0 * scale + off;
      const { hits } = matchCount(est, ref, 0.12, scale, offset);
      if (hits > best.hits) best = { hits, scale, offset };
    }
  }
  for (let ds = -0.004; ds <= 0.0041; ds += 0.001) for (let d = -0.06; d <= 0.0601; d += 0.005) {
    const r = matchCount(est, ref, tol, best.scale + ds, best.offset + d);
    if (r.hits > (best.fine?.hits ?? -1)) best.fine = { ...r, scale: best.scale + ds, offset: best.offset + d };
  }
  const { hits, err, scale, offset } = best.fine;
  const precision = hits / est.length, recall = hits / ref.length;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  // octave-tolerant score (pitch class) – shows how many errors are only octave mistakes
  const pc = (ns) => ns.map((n) => ({ ...n, p: n.p % 12 }));
  const pcHits = matchCount(pc(est), pc(ref), tol, scale, offset).hits;
  const pcP = pcHits / est.length, pcR = pcHits / ref.length;
  return {
    precision, recall, f1,
    pitchClassF1: pcP + pcR ? (2 * pcP * pcR) / (pcP + pcR) : 0,
    offset, scale, matched: hits, est: est.length, ref: ref.length,
    meanOnsetErrorMs: hits ? (err / hits) * 1000 : null,
  };
}
