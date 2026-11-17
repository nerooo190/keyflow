// MusicXML import (.musicxml / .xml / compressed .mxl) → Keyflow notes.
// Handles chords, ties, voices (backup/forward), tempo changes, grand staff (staff 1 = RH, 2 = LH)
// and printed fingerings (become hand-set finger numbers).
import { assignHands, normalizeNotes } from './util.js';

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

async function xmlText(buffer, name) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // .mxl = ZIP
    const { unzipSync, strFromU8 } = await import('https://esm.sh/fflate@0.8.2?target=es2022');
    const files = unzipSync(bytes);
    const container = files['META-INF/container.xml'] && strFromU8(files['META-INF/container.xml']);
    const root = container && /full-path="([^"]+)"/.exec(container)?.[1];
    const key = root && files[root] ? root : Object.keys(files).find((k) => /\.(musicxml|xml)$/i.test(k) && !k.startsWith('META-INF'));
    if (!key) throw new Error('Keine MusicXML-Datei in ' + name);
    return strFromU8(files[key]);
  }
  return new TextDecoder().decode(bytes);
}

const kids = (el, tag) => [...(el?.children || [])].filter((c) => c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0];
const num = (el, tag, d = 0) => { const k = kid(el, tag); return k ? parseFloat(k.textContent) : d; };

export async function parseMusicXML(buffer, name = 'score', DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(await xmlText(buffer, name), 'application/xml');
  const score = doc.documentElement;
  if (!score || !/score-(partwise|timewise)/.test(score.tagName)) throw new Error('Keine gültige MusicXML-Partitur');
  if (score.tagName === 'score-timewise') throw new Error('„timewise“-MusicXML wird nicht unterstützt – bitte als „partwise“ exportieren');
  const title = (score.getElementsByTagName('work-title')[0] || score.getElementsByTagName('movement-title')[0])?.textContent?.trim() || null;

  const parts = kids(score, 'part');
  const raw = []; // {p, start, dur (in quarter notes), staff, part, f}
  const tempo = [{ q: 0, bpm: 120 }]; // tempo map in quarter notes
  parts.forEach((part, pi) => {
    let divisions = 1, pos = 0; // pos in quarter notes
    const open = new Map(); // tie continuation: pitch+staff → note
    for (const measure of kids(part, 'measure')) {
      let lastStart = pos;
      for (const el of [...measure.children]) {
        const tag = el.tagName;
        if (tag === 'attributes') { const d = num(el, 'divisions', 0); if (d) divisions = d; }
        else if (tag === 'direction' || tag === 'sound') {
          const snd = tag === 'sound' ? el : kid(el, 'sound');
          const t = snd?.getAttribute('tempo');
          if (t && pi === 0) tempo.push({ q: pos, bpm: parseFloat(t) });
        } else if (tag === 'backup') pos -= num(el, 'duration') / divisions;
        else if (tag === 'forward') pos += num(el, 'duration') / divisions;
        else if (tag === 'note') {
          const dur = num(el, 'duration') / divisions;
          const isChord = !!kid(el, 'chord');
          const start = isChord ? lastStart : pos;
          if (!isChord) { lastStart = pos; pos += dur; }
          if (kid(el, 'grace') || kid(el, 'rest')) continue;
          const pitch = kid(el, 'pitch');
          if (!pitch) continue;
          const midi = (num(pitch, 'octave') + 1) * 12 + STEP[kid(pitch, 'step').textContent.trim()] + num(pitch, 'alter', 0);
          const staff = num(el, 'staff', 1);
          const ties = kids(el, 'tie').map((t) => t.getAttribute('type'));
          const key = midi + ':' + staff;
          if (ties.includes('stop') && open.has(key)) { // continue the previous note
            const prev = open.get(key);
            prev.dur = start + dur - prev.start;
            if (!ties.includes('start')) open.delete(key);
            continue;
          }
          const fingerEl = el.getElementsByTagName('fingering')[0];
          const f = fingerEl ? parseInt(fingerEl.textContent, 10) : null;
          const n = { p: midi, start, dur, staff, part: pi, f: f >= 1 && f <= 5 ? f : null, vel: el.getAttribute('dynamics') ? Math.min(1, parseFloat(el.getAttribute('dynamics')) / 127) : 0.7 };
          raw.push(n);
          if (ties.includes('start')) open.set(key, n);
        }
      }
    }
  });
  if (!raw.length) throw new Error('Keine Noten in der Partitur gefunden');

  // quarter notes → seconds with the tempo map
  tempo.sort((a, b) => a.q - b.q);
  const toSec = (q) => {
    let t = 0;
    for (let i = 0; i < tempo.length; i++) {
      const from = tempo[i].q, to = i + 1 < tempo.length ? Math.min(q, tempo[i + 1].q) : q;
      if (to <= from) continue; // zero-length segment (e.g. tempo set at the very start)
      t += ((to - from) * 60) / tempo[i].bpm;
    }
    return t;
  };
  const grand = raw.some((n) => n.staff === 2);
  const notes = raw.map((n) => {
    const t = toSec(n.start);
    const out = { p: n.p, t, d: Math.max(0.05, toSec(n.start + n.dur) - t), v: n.vel };
    if (grand) out.h = n.staff === 2 ? 'L' : 'R';
    else if (parts.length === 2) out.h = n.part === 0 ? 'R' : 'L';
    if (n.f) { out.f = n.f; out.fm = true; }
    return out;
  });
  if (!grand && parts.length !== 2) assignHands(notes);
  const bpm = tempo.length > 1 ? tempo[1].bpm : 120;
  return { ...normalizeNotes(notes), title, bpm: Math.round(bpm) };
}
