import { assignHands, normalizeNotes } from './util.js';

const load = () => import('https://esm.sh/@tonejs/midi@2.0.28');

export async function parseMidi(arrayBuffer) {
  const { Midi } = await load();
  const midi = new Midi(arrayBuffer);
  const tracks = midi.tracks.filter((t) => t.notes.length && t.channel !== 9 && !(t.instrument && t.instrument.percussion));
  let notes = [];
  // Two-track piano files are conventionally RH (track 0) + LH (track 1).
  const twoHand = tracks.length === 2;
  tracks.forEach((t, i) => {
    for (const n of t.notes) {
      notes.push({ p: n.midi, t: n.time, d: n.duration, v: n.velocity || 0.7, h: twoHand ? (i === 0 ? 'R' : 'L') : null });
    }
  });
  if (twoHand) {
    // Some files put LH first – swap if track 0 is lower on average.
    const avg = (h) => { const a = notes.filter((n) => n.h === h); return a.reduce((s, n) => s + n.p, 0) / (a.length || 1); };
    if (avg('R') < avg('L')) notes.forEach((n) => (n.h = n.h === 'R' ? 'L' : 'R'));
  } else {
    assignHands(notes);
  }
  return { ...normalizeNotes(notes), title: midi.name || null };
}

/** All pitched notes of a (multi-instrument) MIDI file, drums excluded – input for arrange(). */
export async function midiToRawNotes(arrayBuffer) {
  const { Midi } = await load();
  const midi = new Midi(arrayBuffer);
  const out = [];
  for (const t of midi.tracks) {
    if (t.channel === 9 || t.instrument?.percussion) continue;
    for (const n of t.notes) out.push({ p: n.midi, t: n.time, d: n.duration, a: 0.6 + 0.3 * (n.velocity ?? 0.7), program: t.instrument?.number ?? 0 });
  }
  return out;
}

export async function exportMidi(song) {
  const { Midi } = await load();
  const midi = new Midi();
  midi.name = song.title;
  for (const hand of ['R', 'L']) {
    const tr = midi.addTrack();
    tr.name = hand === 'R' ? 'Right Hand' : 'Left Hand';
    for (const n of song.notes.filter((x) => x.h === hand)) {
      tr.addNote({ midi: n.p, time: n.t, duration: n.d, velocity: Math.min(1, n.v || 0.7) });
    }
  }
  const blob = new Blob([midi.toArray()], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${song.title.replace(/[^\w\- ]+/g, '').trim() || 'song'}.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
