// Polyphonic audio → MIDI transcription with Spotify's open-source Basic Pitch model.
// Runs 100% locally in the browser (TensorFlow.js) – free and unlimited.
//
// Pipeline: decode → mono 22.05 kHz → (optional) drum removal (HPSS) → Basic Pitch
//           → arrangement cleanup (merge, de-ghost, polyphony limit, simplify).
import { normalizeNotes } from './util.js';
import { removePercussion } from './hpss.js';

const BP_URL = 'https://esm.sh/@spotify/basic-pitch@1.0.1';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';
const SR = 22050;

// Same URL Basic Pitch imports internally → same TensorFlow.js instance.
const TF_URL = 'https://esm.sh/@tensorflow/tfjs@^3.2.0?target=es2022';
const TF_WASM_URL = 'https://esm.sh/@tensorflow/tfjs-backend-wasm@3.21.0?target=es2022';
const TF_WASM_FILES = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@3.21.0/dist/';
// GPU first (fastest); many phone GPUs fail to compile TF.js shaders → WebAssembly → plain CPU.
const BACKENDS = ['webgl', 'wasm', 'cpu'];

let bpModule, bpInstance, tf;

async function useBackend(name) {
  tf = tf || (await import(TF_URL));
  if (name === 'wasm' && !tf.findBackend('wasm')) {
    const wasm = await import(TF_WASM_URL);
    wasm.setWasmPaths(TF_WASM_FILES);
  }
  if (!(await tf.setBackend(name))) throw new Error('backend ' + name + ' unavailable');
  await tf.ready();
  if (name === 'webgl') tf.tidy(() => tf.conv2d(tf.ones([1, 8, 8, 1]), tf.ones([3, 3, 1, 1]), 1, 'same').dataSync()); // shader smoke test
  bpInstance = new bpModule.BasicPitch(MODEL_URL); // reload weights on the new backend
}

async function getModel() {
  if (!bpModule) bpModule = await import(BP_URL);
  if (!bpInstance) {
    const saved = localStorage.getItem('kf-tf-backend');
    const order = saved ? [saved, ...BACKENDS.filter((b) => b !== saved)] : BACKENDS;
    for (const b of order) {
      try { await useBackend(b); localStorage.setItem('kf-tf-backend', b); break; }
      catch (e) { console.warn('TF backend failed:', b, e); bpInstance = null; }
    }
    if (!bpInstance) throw new Error('This browser cannot run the AI model. Please update Chrome.');
  }
  return bpModule;
}

/** Run the model; if the current backend crashes mid-way (e.g. shader link error), fall back and retry. */
async function runModel(signal, onProgress) {
  for (;;) {
    const frames = [], onsets = [], contours = [];
    try {
      await bpInstance.evaluateModel(
        signal,
        (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
        (p) => onProgress(`Transcribing notes… (${tf.getBackend() === 'webgl' ? 'GPU' : tf.getBackend().toUpperCase()})`, p),
      );
      return { frames, onsets, contours };
    } catch (e) {
      const cur = tf.getBackend();
      const next = BACKENDS[BACKENDS.indexOf(cur) + 1];
      console.warn('Model failed on', cur, e);
      if (!next) throw e;
      onProgress('GPU not supported – switching to ' + next.toUpperCase() + '…', 0);
      let ok = false;
      for (const b of BACKENDS.slice(BACKENDS.indexOf(cur) + 1)) {
        try { await useBackend(b); localStorage.setItem('kf-tf-backend', b); ok = true; break; } catch (err) { console.warn(err); }
      }
      if (!ok) throw e;
    }
  }
}

async function toMono22k(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    ctx.close();
  }
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

// ---------- Model 2: Magenta Onsets & Frames (piano-specialised), isolated in an iframe ----------
let oafFrame, oafReady, oafSeq = 0;
function oafTranscribe(samples, sampleRate, onProgress) {
  if (!oafFrame) {
    oafFrame = document.createElement('iframe');
    oafFrame.src = new URL('../models/oaf.html', import.meta.url).href;
    oafFrame.style.display = 'none';
    oafReady = new Promise((res) => {
      const h = (e) => { if (e.source === oafFrame.contentWindow && e.data?.type === 'ready') { removeEventListener('message', h); res(); } };
      addEventListener('message', h);
    });
    document.body.appendChild(oafFrame);
  }
  const id = ++oafSeq;
  return oafReady.then(() => new Promise((resolve, reject) => {
    const h = (e) => {
      if (e.source !== oafFrame.contentWindow || e.data?.id !== id) return;
      if (e.data.type === 'progress') onProgress(e.data.stage, e.data.pct);
      else {
        removeEventListener('message', h);
        e.data.type === 'result' ? resolve(e.data.notes) : reject(new Error(e.data.message));
      }
    };
    addEventListener('message', h);
    oafFrame.contentWindow.postMessage({ type: 'transcribe', id, samples, sampleRate }, location.origin);
  }));
}

/** Ensemble: keep notes both models agree on, plus confident notes found by only one. */
function combine(bp, oaf) {
  const key = (n) => n.p;
  const byPitch = new Map();
  for (const n of oaf) { if (!byPitch.has(key(n))) byPitch.set(key(n), []); byPitch.get(key(n)).push(n); }
  const out = [];
  const used = new Set();
  for (const n of bp) {
    const m = (byPitch.get(n.p) || []).find((o) => !used.has(o) && Math.abs(o.t - n.t) < 0.08);
    if (m) { used.add(m); out.push({ ...m, a: Math.max(m.a, n.a) + 0.2 }); } // agreed: trust O&F timing (piano-tuned)
    else if (n.a > 0.55) out.push(n);
  }
  for (const o of oaf) if (!used.has(o) && o.a > 0.5) out.push(o);
  return out;
}

export const MODELS = {
  basicpitch: 'Basic Pitch (any instrument)',
  piano: 'Piano model – Onsets & Frames',
  both: 'Both models combined (best, slower)',
  muscriptor: 'MuScriptor (multi-instrument, server)',
  transkun: 'Transkun (piano, very accurate, server)',
};

/** Decode any audio to 44.1 kHz 16-bit WAV (what Transkun expects; no ffmpeg needed on the server). */
async function toWav44k(arrayBuffer, channels = 1) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ctx.decodeAudioData(arrayBuffer.slice(0)); } finally { ctx.close(); }
  const SR44 = 44100;
  const off = new OfflineAudioContext(channels, Math.ceil(decoded.duration * SR44), SR44);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const buf = await off.startRendering();
  const n = buf.length, data = [...Array(channels)].map((_, c) => buf.getChannelData(c));
  const out = new DataView(new ArrayBuffer(44 + n * channels * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * channels * 2, true); w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, channels, true); out.setUint32(24, SR44, true);
  out.setUint32(28, SR44 * channels * 2, true); out.setUint16(32, channels * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * channels * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) { out.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 32767, true); o += 2; }
  return out.buffer;
}

/** Model 4: Transkun (Yujia Yan, MIT) – piano-specialised Transformer + semi-CRF, runs on the server. */
async function transkunTranscribe(arrayBuffer, onProgress) {
  onProgress('Bereite Audio für Transkun vor …', 0);
  const wav = await toWav44k(arrayBuffer);
  const t0 = Date.now();
  const secs = (wav.byteLength - 44) / 88200;
  // measured on a phone CPU: ~11× the song length (a PC is much faster)
  const est = Math.max(60, Math.ceil(secs / 8) * 90);
  const timer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    onProgress(`Transkun transkribiert … ${Math.floor(el / 60)}:${String(Math.round(el % 60)).padStart(2, '0')} (auf dem Handy ca. ${Math.ceil(est / 60)} min)`, Math.min(0.97, el / est));
  }, 1000);
  try {
    const r = await fetch('/api/transkun', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
    if (!r.ok) throw new Error((await r.text()) || 'Transkun error ' + r.status);
    const { midiToRawNotes } = await import('./midi.js');
    return midiToRawNotes(await r.arrayBuffer());
  } finally {
    clearInterval(timer);
  }
}

/** Model 3: MuScriptor (Kyutai/Mirelo) runs on the server (PyTorch) and returns MIDI. */
async function muscriptorTranscribe(arrayBuffer, size, quantize, onProgress) {
  const t0 = Date.now();
  const timer = setInterval(() => onProgress(`MuScriptor (${size}) transcribing on server… ${Math.round((Date.now() - t0) / 1000)} s`, 0), 1000);
  try {
    const r = await fetch(`/api/muscriptor?model=${size}&quantize=${quantize ? 1 : 0}`, { method: 'POST', body: arrayBuffer });
    if (!r.ok) throw new Error((await r.text()) || 'MuScriptor error ' + r.status);
    const { midiToRawNotes } = await import('./midi.js');
    return midiToRawNotes(await r.arrayBuffer());
  } finally {
    clearInterval(timer);
  }
}

export const MODES = {
  piano: 'Piano arrangement',
  easy: 'Easy (melody + bass)',
  full: 'Full detail',
};

/**
 * @param {ArrayBuffer} arrayBuffer audio or video file contents
 * @param {(stage:string, pct:number)=>void} onProgress
 * @param {{sens:number, split:number, mode:'piano'|'easy'|'full', drums:boolean}} opts
 */
export async function transcribe(arrayBuffer, onProgress = () => {}, opts = {}) {
  const { sens = 0.5, split = 60, mode = 'piano', drums = true, model = 'basicpitch', demucs = false, msSize = 'small', quantize = true } = opts;
  if (demucs) {
    onProgress('Separating instruments with Demucs (server)… this can take a few minutes', 0);
    const r = await fetch('/api/separate', { method: 'POST', body: arrayBuffer });
    if (!r.ok) throw new Error('Demucs: ' + ((await r.text()) || r.status));
    arrayBuffer = await r.arrayBuffer();
  }
  onProgress('Decoding audio…', 0);
  let audio;
  try {
    audio = await toMono22k(arrayBuffer);
  } catch (e) {
    throw new Error('Could not decode this file. Try an MP3, WAV, M4A, OGG, WebM or MP4.');
  }
  if (audio.duration > 60 * 15) throw new Error('Recording is longer than 15 minutes – please trim it.');

  if (model === 'transkun') {
    // drop near-silent ghost notes and artifacts from the zero-padded last segment
    const raw = (await transkunTranscribe(arrayBuffer, onProgress))
      .filter((n) => (n.a - 0.6) / 0.3 >= 0.12 && n.t < audio.duration + 0.1);
    if (!raw.length) throw new Error('Transkun hat keine Noten gefunden.');
    onProgress('Arranging for piano…', 1);
    return normalizeNotes(arrange(raw, { mode, split, sens }));
  }
  if (model === 'muscriptor') {
    // MuScriptor handles full mixes itself (it separates instruments internally) – send the original audio.
    const raw = await muscriptorTranscribe(arrayBuffer, msSize, quantize, onProgress);
    onProgress('Arranging for piano…', 1);
    return normalizeNotes(arrange(raw, { mode, split, sens }));
  }

  let signal = audio.getChannelData(0);
  // normalise loudness
  let peak = 0;
  for (const v of signal) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) signal = signal.map((v) => (v / peak) * 0.9);

  if (drums) signal = await removePercussion(signal, (p) => onProgress('Removing drums…', p));

  let oafNotes = null, notes = [];
  if (model === 'piano' || model === 'both') {
    oafNotes = (await oafTranscribe(signal, SR, (st, p) => onProgress(st, p)))
      .map((n) => ({ p: n.p, t: n.t, d: n.d, a: n.v }));
  }
  if (model === 'piano') {
    onProgress('Arranging for piano…', 1);
    return normalizeNotes(arrange(oafNotes, { mode, split, sens }));
  }

  onProgress('Loading AI model…', 0);
  const { noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly } = await getModel();

  const { frames, onsets, contours } = await runModel(signal, onProgress);

  onProgress('Arranging for piano…', 1);
  // Thresholds: full mixes need stricter values than solo piano.
  const onset = mode === 'full' ? 0.6 - sens * 0.3 : 0.7 - sens * 0.3;
  const frame = mode === 'full' ? 0.4 - sens * 0.2 : 0.45 - sens * 0.2;
  const events = noteFramesToTime(addPitchBendsToNoteEvents(contours,
    outputToNotesPoly(frames, onsets, onset, frame, 11, true, 4200, 27.5, mode === 'full', 11)));
  notes = events.map((e) => ({ p: e.pitchMidi, t: e.startTimeSeconds, d: e.durationSeconds, a: e.amplitude }));
  if (oafNotes) notes = combine(notes, oafNotes);
  notes = arrange(notes, { mode, split, sens });
  return normalizeNotes(notes);
}

/** Turn raw model output into something playable. Exported for testing / re-arranging. */
export function arrange(raw, { mode = 'piano', split = 60, sens = 0.5 } = {}) {
  let notes = raw.map((n) => ({ ...n })).sort((a, b) => a.p - b.p || a.t - b.t);

  // 1. drop tiny fragments, then merge re-detections of the same pitch that touch/overlap
  //    (real repeated notes keep their gap, so riffs keep their rhythm)
  notes = notes.filter((n) => n.d >= 0.07);
  const merged = [];
  for (const n of notes) {
    const last = merged[merged.length - 1];
    if (last && last.p === n.p && n.t - (last.t + last.d) < 0.015) {
      last.d = Math.max(last.d, n.t + n.d - last.t);
      last.a = Math.max(last.a, n.a);
    } else merged.push(n);
  }
  notes = merged;
  notes.sort((a, b) => a.t - b.t || a.p - b.p);

  // 2. loudness gate relative to the local (±2 s) loudest note
  const rel = 0.5 - sens * 0.25;
  notes = notes.filter((n) => {
    let m = 0;
    for (const o of notes) { if (o.t > n.t + 2) break; if (o.t >= n.t - 2) m = Math.max(m, o.a); }
    return n.a >= m * rel;
  });

  // 3. cluster near-simultaneous onsets (chords)
  const clusters = [];
  for (const n of notes) {
    const c = clusters[clusters.length - 1];
    if (c && n.t - c.t < 0.05) c.notes.push(n);
    else clusters.push({ t: n.t, notes: [n] });
  }

  const out = [];
  for (const c of clusters) {
    let ns = c.notes;
    // remove octave / 12th "ghost" harmonics that are much weaker than their root
    ns = ns.filter((n) => !ns.some((r) => (n.p - r.p === 12 || n.p - r.p === 19 || n.p - r.p === 24) && r.a > n.a * 1.15));
    let rh = ns.filter((n) => n.p >= split), lh = ns.filter((n) => n.p < split);
    if (mode === 'easy') {
      rh = rh.length ? [rh.reduce((a, b) => (b.p > a.p ? b : a))] : []; // top melody note
      lh = lh.length ? [lh.reduce((a, b) => (b.p < a.p ? b : a))] : []; // bass note
    } else if (mode === 'piano') {
      // a human hand: max 4 notes spanning ≤ an octave+3rd; keep the strongest, always keep the top/bottom voice
      rh = limitHand(rh, 4, 'top');
      lh = limitHand(lh, 3, 'bottom');
    }
    for (const n of rh) out.push({ p: n.p, t: n.t, d: n.d, v: Math.min(1, 0.45 + n.a), h: 'R' });
    for (const n of lh) out.push({ p: n.p, t: n.t, d: n.d, v: Math.min(1, 0.4 + n.a), h: 'L' });
  }

  if (mode === 'easy') {
    // monophonic per hand: cut overlapping notes
    for (const h of ['R', 'L']) {
      const hs = out.filter((n) => n.h === h).sort((a, b) => a.t - b.t);
      for (let i = 0; i < hs.length - 1; i++) hs[i].d = Math.min(hs[i].d, Math.max(0.08, hs[i + 1].t - hs[i].t));
    }
  }
  return out;
}

function limitHand(ns, max, keep) {
  if (ns.length <= 1) return ns;
  const anchor = keep === 'top' ? ns.reduce((a, b) => (b.p > a.p ? b : a)) : ns.reduce((a, b) => (b.p < a.p ? b : a));
  const inSpan = ns.filter((n) => Math.abs(n.p - anchor.p) <= 15);
  return [anchor, ...inSpan.filter((n) => n !== anchor).sort((a, b) => b.a - a.a).slice(0, max - 1)];
}
