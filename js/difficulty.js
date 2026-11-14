// Difficulty: automatic rating of a song and live simplification of its arrangement.
//   easy     – right hand: melody (top note), no fast runs; left hand: one bass note per beat-ish
//   medium   – right hand: melody + one harmony note; left hand: bass line
//   hard     – right hand ≤ 3 notes per chord, left hand ≤ 2
//   original – everything as transcribed

export const LEVELS = [
  { id: 'easy', label: 'Leicht' },
  { id: 'medium', label: 'Mittel' },
  { id: 'hard', label: 'Schwer' },
  { id: 'original', label: 'Original' },
];

const CLUSTER = 0.04; // notes closer than this start "together" (chord)

function clusters(notes) {
  const out = [];
  for (const n of [...notes].sort((a, b) => a.t - b.t || a.p - b.p)) {
    const c = out[out.length - 1];
    if (c && n.t - c.t < CLUSTER) c.notes.push(n);
    else out.push({ t: n.t, notes: [n] });
  }
  return out;
}

/** Rate a song 1 (very easy) … 10 (very hard). */
export function rate(notes, duration) {
  if (!notes?.length) return { score: 1, label: 'Leicht' };
  const dur = Math.max(1, duration || notes.reduce((m, n) => Math.max(m, n.t + n.d), 0));
  const nps = notes.length / dur; // density
  const cs = clusters(notes);
  const chord = notes.length / cs.length; // avg notes per onset
  let fast = 0; // share of very short gaps (runs)
  for (let i = 1; i < cs.length; i++) if (cs[i].t - cs[i - 1].t < 0.13) fast++;
  const fastShare = cs.length > 1 ? fast / (cs.length - 1) : 0;
  const both = new Set(notes.map((n) => n.h)).size > 1 ? 1 : 0;
  let jumps = 0; // hand position jumps > octave within a hand
  for (const h of ['L', 'R']) {
    const hs = notes.filter((n) => n.h === h).sort((a, b) => a.t - b.t);
    for (let i = 1; i < hs.length; i++) if (Math.abs(hs[i].p - hs[i - 1].p) > 12 && hs[i].t - hs[i - 1].t < 0.4) jumps++;
  }
  const jumpRate = jumps / dur;
  const raw = nps * 0.6 + (chord - 1) * 1.0 + fastShare * 5 + both * 0.5 + jumpRate * 2;
  const score = Math.max(1, Math.min(10, Math.round(raw)));
  return { score, label: score <= 3 ? 'Leicht' : score <= 6 ? 'Mittel' : 'Schwer', nps: +nps.toFixed(2), chord: +chord.toFixed(2) };
}

/** Return a simplified copy of the notes for a difficulty level (keeps the original index in `oi`). */
export function simplify(notes, level = 'original') {
  const src = notes.map((n, i) => ({ ...n, oi: i }));
  if (level === 'original') return src;
  const rules = {
    easy: { R: 1, L: 1, minGapR: 0.2, minGapL: 0.45 },
    medium: { R: 2, L: 1, minGapR: 0.12, minGapL: 0.22 },
    hard: { R: 3, L: 2, minGapR: 0.06, minGapL: 0.1 },
  }[level];
  const out = [];
  for (const h of ['R', 'L']) {
    const max = rules[h], minGap = h === 'R' ? rules.minGapR : rules.minGapL;
    let lastT = -1e9;
    const kept = [];
    for (const c of clusters(src.filter((n) => n.h === h))) {
      if (c.t - lastT < minGap) continue; // drop fast run notes / ornaments
      // RH keeps the melody (top) first, LH keeps the bass (bottom) first, then the next voices
      const sorted = [...c.notes].sort((a, b) => (h === 'R' ? b.p - a.p : a.p - b.p));
      const pick = [sorted[0]];
      for (const n of sorted.slice(1)) {
        if (pick.length >= max) break;
        if (Math.abs(n.p - pick[0].p) <= 12 && !pick.some((x) => x.p === n.p)) pick.push(n); // stay within one hand span
      }
      kept.push(...pick.map((n) => ({ ...n })));
      lastT = c.t;
    }
    // in easy mode let notes ring until the next kept note (fewer, longer notes are easier to read)
    if (level === 'easy') {
      const byT = kept.sort((a, b) => a.t - b.t);
      for (let i = 0; i < byT.length; i++) {
        const next = byT.find((x, j) => j > i && x.t > byT[i].t + 0.01);
        if (next) byT[i].d = Math.min(Math.max(byT[i].d, next.t - byT[i].t - 0.02), 2);
      }
    }
    out.push(...kept);
  }
  return out.sort((a, b) => a.t - b.t || a.p - b.p);
}
