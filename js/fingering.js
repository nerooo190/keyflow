// Automatic piano fingering (1 = thumb … 5 = pinky) per hand.
// Melodic lines: dynamic programming (Viterbi) over finger choices with an ergonomic cost model
// (comfortable spans, thumb-under / finger-over crossings, black-key thumb/pinky penalties).
// Chords: fingers spread by interval.
import { isBlack } from './util.js';

// Comfortable relative distance (semitones) between finger a and finger b for the RH, ascending.
// MIN/MAX are rough practical limits for a normal adult hand.
const REL = { // [min, comfortableMin, comfortableMax, max]
  '1-2': [-5, 1, 4, 10], '1-3': [-4, 3, 7, 12], '1-4': [-3, 5, 9, 14], '1-5': [-1, 7, 10, 15],
  '2-3': [1, 1, 2, 5], '2-4': [1, 3, 4, 7], '2-5': [2, 5, 6, 9],
  '3-4': [1, 1, 2, 4], '3-5': [1, 3, 4, 7], '4-5': [1, 1, 2, 5],
};

function spanCost(f1, f2, d) {
  // d = signed semitone distance from note with f1 to note with f2 (already mirrored for LH)
  if (f1 === f2) return d === 0 ? 0.5 : 6 + Math.abs(d) * 0.5;
  let a = f1, b = f2, dist = d;
  if (a > b) { a = f2; b = f1; dist = -d; }
  const [mn, cmin, cmax, mx] = REL[`${a}-${b}`];
  let c = 0;
  if (dist < cmin) c += (cmin - dist) * (dist < mn ? 3 : 1);
  if (dist > cmax) c += (dist - cmax) * (dist > mx ? 3 : 1);
  // crossings: thumb-under (ascending onto 1) or finger-over (descending from 1) are allowed but cost a bit
  const crossing = (f2 === 1 && d > 0 && f1 > 1) || (f1 === 1 && d < 0 && f2 > 1);
  if (crossing) {
    const other = f1 === 1 ? f2 : f1;
    c = Math.max(0, Math.abs(d) - 4) + (other === 5 ? 6 : other === 4 ? 2.5 : 1.5);
  } else if ((d > 0 && f2 < f1) || (d < 0 && f2 > f1)) {
    c += 8; // non-thumb crossing: very awkward
  }
  return c;
}

const keyCost = (f, p) => (isBlack(p) && (f === 1 || f === 5) ? 1.5 : 0);

function chordFingers(pitches) {
  // pitches sorted ascending (mirrored for LH so index 0 = thumb side)
  const n = pitches.length;
  if (n === 1) return [null];
  const span = pitches[n - 1] - pitches[0];
  const top = n >= 5 ? 5 : Math.min(5, Math.max(n, 1 + Math.round(span / 1.75)));
  const out = [1];
  for (let i = 1; i < n - 1; i++) {
    const rel = (pitches[i] - pitches[0]) / Math.max(1, span);
    out.push(Math.round(1 + rel * (top - 1)));
  }
  out.push(top);
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + 1); // strictly increasing
  for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - 1);
  return out.map((f) => Math.max(1, Math.min(5, f)));
}

function fingerHand(notes, hand) {
  const sign = hand === 'L' ? -1 : 1; // mirror LH so the same rules apply
  const events = [];
  for (const n of notes) {
    const e = events[events.length - 1];
    if (e && n.t - e.t < 0.04) e.notes.push(n);
    else events.push({ t: n.t, notes: [n] });
  }
  // fixed fingers for chords, DP for the rest
  for (const e of events) {
    e.notes.sort((a, b) => sign * (a.p - b.p));
    if (e.notes.length > 1) {
      const fs = chordFingers(e.notes.map((n) => sign * n.p));
      e.notes.forEach((n, i) => { if (!n.fm) n.f = fs[i]; }); // manual fingers (fm) win
    }
  }
  // Viterbi over single-note events; chords act as fixed anchors (their outermost note)
  const states = [1, 2, 3, 4, 5];
  let prev = null; // {p, cost[5], back[]}
  const trail = [];
  for (const e of events) {
    const fixed = e.notes.length > 1 || !!e.notes[0].fm; // chords and hand-set fingers are anchors
    const anchor = e.notes[e.notes.length - 1];
    const mp = sign * anchor.p;
    const cost = [], back = [];
    for (const f of states) {
      if (fixed && f !== anchor.f) { cost.push(Infinity); back.push(-1); continue; }
      let best = 0, bi = -1;
      if (prev) {
        best = Infinity;
        const gap = e.t - prev.t;
        const relax = gap > 1.2 ? 0.25 : 1; // after a long rest the hand can move freely
        for (let k = 0; k < 5; k++) {
          if (prev.cost[k] === Infinity) continue;
          const c = prev.cost[k] + relax * spanCost(k + 1, f, mp - prev.mp);
          if (c < best) { best = c; bi = k; }
        }
      } else {
        best = f === 3 ? 0 : 0.5; // start roughly in the middle
      }
      cost.push(best + keyCost(f, anchor.p));
      back.push(bi);
    }
    prev = { t: e.t, mp, cost };
    trail.push({ e, back, fixed });
  }
  if (!trail.length) return;
  let k = prev.cost.indexOf(Math.min(...prev.cost));
  for (let i = trail.length - 1; i >= 0; i--) {
    const { e, back, fixed } = trail[i];
    if (!fixed) e.notes[0].f = k + 1;
    k = back[k];
    if (k < 0 && i > 0) k = trail[i - 1].fixed ? trail[i - 1].e.notes[trail[i - 1].e.notes.length - 1].f - 1 : 2;
  }
}

/** Mutates notes: sets n.f (1-5) for every note. */
export function computeFingering(notes) {
  for (const h of ['R', 'L']) fingerHand(notes.filter((n) => n.h === h).sort((a, b) => a.t - b.t || a.p - b.p), h);
  return notes;
}
