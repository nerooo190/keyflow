// Demucs (HTDemucs, Meta) in the browser via demucs-web (MIT) + onnxruntime-web (MIT).
// Removes vocals and drums before transcription: keeps "other" (piano, keys, guitar …) + "bass".
// No server needed. Model ≈181 MB, downloaded once and kept in the browser cache.
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.mjs';
const ORT_FILES = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const DEMUCS = 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/src/index.js';
const MODEL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const SR = 44100;

let processor = null;

async function modelBuffer(onProgress) {
  const cache = 'caches' in self ? await caches.open('keyflow-models') : null;
  const hit = await cache?.match(MODEL);
  if (hit) return hit.arrayBuffer();
  const r = await fetch(MODEL);
  if (!r.ok) throw new Error('Demucs-Modell konnte nicht geladen werden (' + r.status + ')');
  const total = +r.headers.get('content-length') || 181e6;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress('Lade Demucs-Modell (einmalig, ~181 MB) …', got / total);
  }
  const blob = new Blob(chunks);
  try { await cache?.put(MODEL, new Response(blob)); } catch { /* quota – fine, just not cached */ }
  return blob.arrayBuffer();
}

async function ensure(onProgress) {
  if (processor) return processor;
  const [ort, { DemucsProcessor }] = await Promise.all([import(ORT), import(DEMUCS)]);
  ort.env.wasm.wasmPaths = ORT_FILES;
  // multi-threading needs cross-origin isolation (not available on GitHub Pages) → single thread otherwise
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  const p = new DemucsProcessor({
    ort,
    sessionOptions: { executionProviders: ['wasm'] },
    onProgress: (x) => onProgress('Trenne Instrumente (Demucs im Browser) …', typeof x === 'number' ? x : x.progress),
  });
  onProgress('Lade Demucs-Modell …', 0);
  await p.loadModel(await modelBuffer(onProgress));
  processor = p;
  return p;
}

function wavMono(samples) {
  const n = samples.length;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return v.buffer;
}

/** Returns a WAV (ArrayBuffer) with vocals + drums removed. */
export async function separateInBrowser(arrayBuffer, onProgress = () => {}) {
  const p = await ensure(onProgress);
  onProgress('Bereite Audio vor …', 0);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ctx.decodeAudioData(arrayBuffer.slice(0)); } finally { ctx.close(); }
  const off = new OfflineAudioContext(2, Math.ceil(decoded.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const buf = await off.startRendering();
  const res = await p.separate(buf.getChannelData(0), buf.getChannelData(1));
  const n = res.other.left.length;
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = (res.other.left[i] + res.other.right[i] + res.bass.left[i] + res.bass.right[i]) * 0.5;
  return wavMono(mix);
}
