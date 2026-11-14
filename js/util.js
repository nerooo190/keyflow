export const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SOLFEGE = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
export const isBlack = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
export const noteName = (p, solfege = false) => (solfege ? SOLFEGE : NAMES)[p % 12];
export const octaveOf = (p) => Math.floor(p / 12) - 1;

export function parseNoteName(s) {
  const m = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(s.trim());
  if (!m) throw new Error('Bad note ' + s);
  let pc = NAMES.indexOf(m[1].toUpperCase());
  if (m[2] === '#') pc++;
  if (m[2] === 'b') pc--;
  return (parseInt(m[3], 10) + 1) * 12 + pc;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Procedural abstract cover art as CSS background. */
export function coverStyle(seed) {
  const h = hash(String(seed));
  const a = h % 360, b = (a + 40 + (h >> 8) % 120) % 360, c = (b + 60) % 360;
  const kind = (h >> 4) % 4;
  const x = 20 + (h >> 12) % 60, y = 20 + (h >> 16) % 60;
  if (kind === 0) return `background: repeating-radial-gradient(circle at ${x}% ${y}%, hsl(${a} 90% 55%) 0 6%, hsl(${b} 85% 35%) 9% 12%)`;
  if (kind === 1) return `background: conic-gradient(from ${a}deg at ${x}% ${y}%, hsl(${a} 85% 60%), hsl(${b} 80% 40%), hsl(${c} 85% 65%), hsl(${a} 85% 60%))`;
  if (kind === 2) return `background: radial-gradient(circle at ${x}% ${y}%, hsl(${c} 95% 75%) 0 10%, transparent 40%), linear-gradient(135deg, hsl(${a} 80% 50%), hsl(${b} 70% 25%))`;
  return `background: radial-gradient(circle at ${x}% ${y}%, #000 0 18%, hsl(${a} 90% 50%) 30%, hsl(${b} 80% 30%) 70%)`;
}

export function relDay(ts) {
  if (!ts) return null;
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

export const fmtTime = (s) => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Inline icon (generated set in /icons). */
export const ic = (name, cls = '') => `<img class="ic${cls ? ' ' + cls : ''}" src="icons/${name}.webp" alt="" draggable="false">`;

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Split notes into hands by pitch (simple but effective default). */
export function assignHands(notes, split = 60) {
  for (const n of notes) n.h = n.p < split ? 'L' : 'R';
  return notes;
}

export function normalizeNotes(notes) {
  notes = notes.filter((n) => n.p >= 21 && n.p <= 108 && n.d > 0.02);
  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  const duration = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
  return { notes, duration };
}
