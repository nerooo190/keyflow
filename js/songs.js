// Built-in public-domain arrangements. Format: "NOTE[+NOTE]:beats" tokens, "R:beats" = rest, "|" ignored (bar lines).
import { parseNoteName } from './util.js';

function seq(str, bpm, hand, offsetBeats = 0) {
  const spb = 60 / bpm;
  const out = [];
  let beat = offsetBeats;
  for (const tok of str.split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const [pitches, len = '1'] = tok.split(':');
    const beats = parseFloat(len);
    if (pitches !== 'R') {
      for (const n of pitches.split('+')) {
        out.push({ p: parseNoteName(n), t: beat * spb, d: beats * spb * 0.95, v: hand === 'R' ? 0.8 : 0.6, h: hand });
      }
    }
    beat += beats;
  }
  return out;
}

function song(id, title, genre, bpm, rh, lh, clickBpm = bpm) {
  return {
    id, title, genre, bpm: clickBpm,
    build() {
      const notes = [...seq(rh, bpm, 'R'), ...(lh ? seq(lh, bpm, 'L') : [])].sort((a, b) => a.t - b.t || a.p - b.p);
      const duration = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
      return { notes, duration };
    },
  };
}

const C = 'C3+G3:4', F = 'F3+A3:4', G = 'G2+G3:4';

export const CATALOG = [
  song('builtin-fur-elise', 'Für Elise (Beethoven)', 'Classical', 300,
    `E5 D#5 | E5 D#5 E5 B4 D5 C5 | A4:2 R C4 E4 A4 | B4:2 R E4 G#4 B4 | C5:2 R E4 E5 D#5 |
     E5 D#5 E5 B4 D5 C5 | A4:2 R C4 E4 A4 | B4:2 R E4 C5 B4 | A4:6`,
    `R:2 | R:6 | A2 E3 A3 R:3 | E2 E3 G#3 R:3 | A2 E3 A3 R:3 | R:6 | A2 E3 A3 R:3 | E2 E3 G#3 R:3 | A2+E3+A3:6`, 100),
  song('builtin-ode-to-joy', 'Ode to Joy (Beethoven)', 'Classical', 110,
    `E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4:1.5 D4:0.5 D4:2 |
     E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:0.5 C4:2 |
     D4 D4 E4 C4 | D4 E4:0.5 F4:0.5 E4 C4 | D4 E4:0.5 F4:0.5 E4 D4 | C4 D4 G3:2 |
     E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:0.5 C4:2`,
    `${C} B2+G3:4 ${C} ${G} ${C} B2+G3:4 ${C} G2+G3:2 C3+G3:2 |
     ${G} G2+G3:2 C3+G3:2 G2+G3:2 C3+G3:2 C3:2 G2:2 |
     ${C} B2+G3:4 ${C} G2+G3:2 C3+G3:2`),
  song('builtin-minuet-g', 'Minuet in G (Petzold)', 'Classical', 120,
    `D5 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | D5 G4 G4 | E5 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | G5 G4 G4 |
     C5 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | B4 C5:0.5 B4:0.5 A4:0.5 G4:0.5 | F#4 G4:0.5 A4:0.5 B4:0.5 G4:0.5 | A4:3 |
     D5 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | D5 G4 G4 | E5 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | G5 G4 G4 |
     C5 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | B4 C5:0.5 B4:0.5 A4:0.5 G4:0.5 | A4 B4:0.5 A4:0.5 G4:0.5 F#4:0.5 | G4:3`,
    `G2+D3:3 B2:3 C3:3 B2:3 A2:3 G2:3 D3:3 D3+F#3:3 |
     G2+D3:3 B2:3 C3:3 B2:3 A2:3 G2:3 D3:3 G2+G3:3`),
  song('builtin-canon-d', 'Canon in D (Pachelbel)', 'Classical', 70,
    `F#5:2 E5:2 D5:2 C#5:2 B4:2 A4:2 B4:2 C#5:2 | D5:2 C#5:2 B4:2 A4:2 G4:2 F#4:2 G4:2 E4:2 |
     D4 F#4 A4 G4 F#4 D4 F#4 E4 D4 B3 D4 A4 G4 B4 A4 G4 | F#4 D4 E4 C#5 D5 F#5 A5 A4 B4 G4 A4 F#4 D4 D5 D5:2`,
    `D3:2 A2:2 B2:2 F#2:2 G2:2 D2:2 G2:2 A2:2 | D3:2 A2:2 B2:2 F#2:2 G2:2 D2:2 G2:2 A2:2 |
     D3:2 A2:2 B2:2 F#2:2 G2:2 D2:2 G2:2 A2:2 | D3:2 A2:2 B2:2 F#2:2 G2:2 D2:2 G2:2 A2+D3:2`),
  song('builtin-twinkle', 'Twinkle Twinkle Little Star', 'Kids', 100,
    `C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 |
     G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 |
     C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2`,
    `${C} F3+A3:2 C3+G3:2 F3+A3:2 C3+G3:2 G2+G3:2 C3+G3:2 |
     C3+G3:2 F3+A3:2 C3+G3:2 G2+G3:2 C3+G3:2 F3+A3:2 C3+G3:2 G2+G3:2 |
     ${C} F3+A3:2 C3+G3:2 F3+A3:2 C3+G3:2 G2+G3:2 C3+G3:2`),
  song('builtin-mary', 'Mary Had a Little Lamb', 'Kids', 110,
    `E4 D4 C4 D4 | E4 E4 E4:2 | D4 D4 D4:2 | E4 G4 G4:2 | E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C4:4`,
    `${C} ${C} ${G} ${C} ${C} ${C} ${G} ${C}`),
  song('builtin-frere-jacques', 'Frère Jacques', 'Kids', 110,
    `C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G4:2 | E4 F4 G4:2 |
     G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 | G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 | C4 G3 C4:2 | C4 G3 C4:2`,
    `${C} ${C} ${C} ${C} ${C} ${C} ${C} ${C}`),
  song('builtin-jingle-bells', 'Jingle Bells', 'Holiday', 120,
    `E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:0.5 | E4:4 | F4 F4 F4:1.5 F4:0.5 | F4 E4 E4 E4:0.5 E4:0.5 | E4 D4 D4 E4 | D4:2 G4:2 |
     E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:0.5 | E4:4 | F4 F4 F4 F4 | F4 E4 E4 E4:0.5 E4:0.5 | G4 G4 F4 D4 | C4:4`,
    `${C} ${C} ${C} ${C} ${F} ${C} ${G} ${G} ${C} ${C} ${C} ${C} ${F} ${C} ${G} ${C}`),
  song('builtin-happy-birthday', 'Happy Birthday', 'Holiday', 100,
    `G4:0.75 G4:0.25 | A4 G4 C5 | B4:2 G4:0.75 G4:0.25 | A4 G4 D5 | C5:2 G4:0.75 G4:0.25 | G5 E5 C5 | B4 A4 F5:0.75 F5:0.25 | E5 C5 D5 | C5:3`,
    `R:1 | C3+G3:3 | G2+F3:3 | G2+F3:3 | C3+G3:3 | C3+E3:3 | F3+A3:3 | C3+G3:2 G2:1 | C3+G3:3`),
];

export const GENRES = ['Classical', 'Kids', 'Holiday', 'Pop', 'Movie themes', 'Anime', 'K-pop', 'Video games'];

export function searchCatalog(q, genre) {
  q = (q || '').toLowerCase().trim();
  return CATALOG.filter((s) => (!genre || s.genre === genre) && (!q || s.title.toLowerCase().includes(q) || s.genre.toLowerCase().includes(q)));
}
