// Audio-transcription → sheet music: tempo/beat, key and metre detection, quantisation,
// and a MusicXML writer for a two-staff piano score (rendered with OpenSheetMusicDisplay).

// ---------------- analysis ----------------

/** Tempo (BPM) and beat phase from note onsets: grid search with a mild prior around 100 BPM. */
export function detectTempo(notes) {
  const on = [];
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const last = on[on.length - 1];
    if (last && n.t - last.t < 0.04) last.w += n.v ?? 0.7; else on.push({ t: n.t, w: n.v ?? 0.7 });
  }
  if (on.length < 4) return { bpm: 100, phase: on[0]?.t || 0 };
  let best = { score: -Infinity, bpm: 100, phase: 0 };
  for (let bpm = 50; bpm <= 200; bpm += 0.5) {
    const beat = 60 / bpm, sub = beat / 2;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 100) / 0.6) ** 2);
    for (let k = 0; k < 24; k++) {
      const ph = (k / 24) * beat;
      let s = 0;
      for (const o of on) {
        const x = (o.t - ph) / sub;
        s += o.w * Math.cos(2 * Math.PI * x) * (Math.abs(x - Math.round(x)) < 0.12 ? 1.2 : 1);
        s += 0.5 * o.w * Math.cos(2 * Math.PI * ((o.t - ph) / beat)); // reward notes on the beat
      }
      s *= prior;
      if (s > best.score) best = { score: s, bpm, phase: ph };
    }
  }
  // correct the classic 3:2 confusions (e.g. a slow piece in half/quarter notes read as dotted rhythms):
  // switch if clearly more onsets fall exactly on beats at 2/3 or 3/2 of the tempo
  const onBeat = (bpm) => {
    const beat = 60 / bpm;
    let bestR = 0, bestPh = 0;
    for (let k = 0; k < 24; k++) {
      const ph = (k / 24) * beat;
      let hit = 0, all = 0;
      for (const o of on) { const x = (o.t - ph) / beat; all += o.w; if (Math.abs(x - Math.round(x)) < 0.1) hit += o.w; }
      if (hit / all > bestR) { bestR = hit / all; bestPh = ph; }
    }
    return { r: bestR, ph: bestPh };
  };
  let pick = { bpm: best.bpm, phase: best.phase, r: onBeat(best.bpm).r };
  for (const f of [2 / 3, 3 / 2]) {
    const bpm = best.bpm * f;
    if (bpm < 50 || bpm > 180) continue;
    const c = onBeat(bpm);
    if (c.r > pick.r + 0.15) pick = { bpm, phase: c.ph, r: c.r };
  }
  return { bpm: Math.round(pick.bpm), phase: pick.phase };
}

// Krumhansl–Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const corr = (a, b) => {
  const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1);
};
// fifths for major keys by tonic pitch class (prefer the common spelling)
const MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Key via Krumhansl–Schmuckler on duration-weighted pitch classes. */
export function detectKey(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.p % 12] += Math.min(2, n.d) * (n.v ?? 0.7);
  let best = { r: -2 };
  for (let t = 0; t < 12; t++) {
    const rot = (prof) => prof.map((_, i) => prof[(i - t + 12) % 12]);
    // penalise keys whose scale leaves out much of the played material (e.g. F natural rules out G major)
    const total = h.reduce((x, y) => x + y) || 1;
    const outside = (steps) => h.reduce((acc, w, pc) => acc + (steps.includes((pc - t + 12) % 12) ? 0 : w), 0) / total;
    const rM = corr(h, rot(MAJOR)) - 1.5 * outside([0, 2, 4, 5, 7, 9, 11]);
    const rm = corr(h, rot(MINOR)) - 1.5 * outside([0, 2, 3, 5, 7, 8, 10, 11]); // natural + harmonic minor
    if (rM > best.r) best = { r: rM, tonic: t, mode: 'major' };
    if (rm > best.r) best = { r: rm, tonic: t, mode: 'minor' };
  }
  const fifths = best.mode === 'major' ? MAJOR_FIFTHS[best.tonic] : MAJOR_FIFTHS[(best.tonic + 3) % 12];
  const names = fifths < 0 ? NAMES_FLAT : NAMES_SHARP;
  return { tonic: best.tonic, mode: best.mode, fifths, name: `${names[best.tonic]}-${best.mode === 'major' ? 'Dur' : 'Moll'}` };
}

/** 3/4 vs 4/4 from accents: which bar length puts more weight on downbeats. */
export function detectMeter(notes, bpm, phase) {
  const beat = 60 / bpm;
  const acc = (len) => {
    let best = 0;
    for (let off = 0; off < len; off++) {
      let down = 0, all = 0;
      for (const n of notes) {
        const b = Math.round((n.t - phase) / beat);
        if (Math.abs((n.t - phase) / beat - b) > 0.2) continue;
        const w = (n.v ?? 0.7) * (n.p < 55 ? 1.5 : 1); // bass notes mark downbeats
        all += w;
        if (((b - off) % len + len) % len === 0) down += w;
      }
      best = Math.max(best, all ? (down / all) * len : 0);
    }
    return best;
  };
  return acc(3) > acc(4) * 1.08 ? 3 : 4;
}

export function analyze(notes, known = {}) {
  const t = known.bpm ? { bpm: known.bpm, phase: notes.length ? Math.min(...notes.map((n) => n.t)) : 0 } : detectTempo(notes);
  const key = detectKey(notes);
  const beats = known.beats || detectMeter(notes, t.bpm, t.phase);
  return { bpm: t.bpm, phase: t.phase, key, beats };
}

// ---------------- quantisation + MusicXML ----------------
const DIV = 4; // divisions per quarter note → 16th grid
const STEPS_SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const STEPS_FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
// note values in 16ths that can be written with one symbol (incl. dotted)
const VALUES = [[16, 'whole', 0], [12, 'half', 1], [8, 'half', 0], [6, 'quarter', 1], [4, 'quarter', 0], [3, 'eighth', 1], [2, 'eighth', 0], [1, '16th', 0]];
const splitValue = (len) => { const out = []; while (len > 0) { const v = VALUES.find(([u]) => u <= len); out.push(v); len -= v[0]; } return out; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Quantise one staff into two voices on the 16th grid: [{start, len, pitches:[{p,f}]}].
 * Voice 1 carries the moving line/chords; notes that are held clearly longer while voice 1 moves on
 * go to voice 2 (instead of being cut off), like in printed piano music.
 */
function quantStaff(notes, beatSec, phase) {
  const unit = beatSec / DIV;
  const q = notes.map((n) => ({ s: Math.max(0, Math.round((n.t - phase) / unit)), len: Math.max(1, Math.round(n.d / unit)), p: n.p, f: n.f }))
    .sort((x, y) => x.s - y.s || y.p - x.p);
  const onsets = [...new Set(q.map((n) => n.s))].sort((x, y) => x - y);
  const nextOnset = (s) => onsets.find((o) => o > s) ?? Infinity;
  const v1 = new Map(), v2 = new Map();
  let v2End = 0;
  for (const n of q) {
    const nxt = nextOnset(n.s);
    const held = n.s + n.len > nxt + 1 && n.len >= 4; // sustains well past the next onset
    const target = held && v2End <= n.s ? v2 : v1;
    if (!target.has(n.s)) target.set(n.s, { start: n.s, len: n.len, pitches: [] });
    const ev = target.get(n.s);
    if (!ev.pitches.some((x) => x.p === n.p)) ev.pitches.push({ p: n.p, f: n.f });
    ev.len = target === v2 ? Math.max(ev.len, n.len) : ev.len;
    if (target === v2) v2End = n.s + ev.len;
  }
  const finish = (m) => {
    const evs = [...m.values()].sort((x, y) => x.start - y.start);
    for (let i = 0; i < evs.length - 1; i++) evs[i].len = Math.max(1, Math.min(evs[i].len, evs[i + 1].start - evs[i].start));
    return evs;
  };
  return [finish(v1), finish(v2)];
}

function pitchXml(p, flats) {
  const [step, alter] = (flats ? STEPS_FLAT : STEPS_SHARP)[p % 12];
  const octave = Math.floor(p / 12) - 1 + (step === 'C' && alter === -1 ? 1 : 0);
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
}

/**
 * Build a MusicXML score-partwise document for a two-staff piano part.
 * @param {Array} notes Keyflow notes {p,t,d,v,h,f}
 * @param {{title?:string, bpm:number, phase:number, beats:number, key:{fifths:number, mode:string}}} a analysis
 */
export function toMusicXML(notes, a, title = 'Keyflow') {
  const beatSec = 60 / a.bpm;
  const flats = a.key.fifths < 0;
  const barLen = a.beats * DIV;
  const staves = { 1: quantStaff(notes.filter((n) => n.h !== 'L'), beatSec, a.phase), 2: quantStaff(notes.filter((n) => n.h === 'L'), beatSec, a.phase) };
  const end = Math.max(barLen, ...[1, 2].flatMap((s) => staves[s].flat().map((e) => e.start + e.len)));
  const bars = Math.ceil(end / barLen);

  const voiceXml = (events, staff, voice, bar, hiddenRests) => {
    const b0 = bar * barLen, b1 = b0 + barLen;
    let pos = b0, xml = '';
    const rest = (len) => splitValue(len).forEach(([u, type, dot]) => {
      xml += `<note${hiddenRests ? ' print-object="no"' : ''}><rest/><duration>${u}</duration><voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}<staff>${staff}</staff></note>`;
    });
    for (const ev of events) {
      const s = ev.start, e = ev.start + ev.len;
      if (e <= b0 || s >= b1) continue;
      const from = Math.max(s, b0), to = Math.min(e, b1);
      if (from > pos) rest(from - pos);
      const pieces = splitValue(to - from);
      pieces.forEach(([u, type, dot], pi) => {
        const tiedIn = from > s || pi > 0, tiedOut = to < e || pi < pieces.length - 1;
        ev.pitches.forEach((pt, ci) => {
          const fing = pt.f && !tiedIn ? `<technical><fingering>${pt.f}</fingering></technical>` : '';
          const ties = (tiedIn ? '<tie type="stop"/>' : '') + (tiedOut ? '<tie type="start"/>' : '');
          const tied = (tiedIn ? '<tied type="stop"/>' : '') + (tiedOut ? '<tied type="start"/>' : '');
          const stem = voice % 4 === 1 ? 'up' : 'down';
          xml += `<note>${ci ? '<chord/>' : ''}${pitchXml(pt.p, flats)}<duration>${u}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}${hasV2[staff] ? `<stem>${stem}</stem>` : ''}<staff>${staff}</staff>${tied || fing ? `<notations>${tied}${fing}</notations>` : ''}</note>`;
        });
      });
      pos = to;
    }
    if (pos < b1) rest(b1 - pos);
    return xml;
  };
  const hasV2 = { 1: staves[1][1].length > 0, 2: staves[2][1].length > 0 };
  const inBar = (evs, bar) => evs.some((e) => e.start < (bar + 1) * barLen && e.start + e.len > bar * barLen);
  const staffXml = (staff, bar) => {
    const [v1, v2] = staves[staff];
    const base = staff === 1 ? 1 : 5;
    let xml = voiceXml(v1, staff, base, bar, false);
    if (inBar(v2, bar)) xml += `<backup><duration>${barLen}</duration></backup>` + voiceXml(v2, staff, base + 1, bar, true);
    return xml;
  };

  let measures = '';
  for (let m = 0; m < bars; m++) {
    let attr = '';
    if (m === 0) {
      attr = `<attributes><divisions>${DIV}</divisions><key><fifths>${a.key.fifths}</fifths><mode>${a.key.mode}</mode></key>` +
        `<time><beats>${a.beats}</beats><beat-type>4</beat-type></time><staves>2</staves>` +
        `<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>` +
        `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${a.bpm}</per-minute></metronome></direction-type><sound tempo="${a.bpm}"/></direction>`;
    }
    measures += `<measure number="${m + 1}">${attr}${staffXml(1, m)}<backup><duration>${barLen}</duration></backup>${staffXml(2, m)}</measure>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work>
<identification><creator type="composer">Transkribiert mit Keyflow</creator><encoding><software>Keyflow Piano</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Klavier</part-name></score-part></part-list>
<part id="P1">${measures}</part></score-partwise>`;
}
