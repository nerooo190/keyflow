// Harmonic/percussive source separation (median-filtering, Fitzgerald 2010).
// Removes drums/hi-hats from a full mix before transcription, which hugely reduces
// garbage notes on pop / hip-hop songs. Processes in blocks to keep memory low.

const N = 2048, HOP = 512, KT = 17, KF = 17; // fft size, hop, median kernels (time, freq)

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

function median(buf, len) {
  // insertion sort on a small scratch buffer
  for (let i = 1; i < len; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
    buf[j + 1] = v;
  }
  return buf[len >> 1];
}

/**
 * @param {Float32Array} x mono signal
 * @param {(pct:number)=>void} onProgress
 * @returns {Promise<Float32Array>} harmonic part
 */
export async function removePercussion(x, onProgress = () => {}) {
  const BINS = N / 2 + 1;
  const BLOCK = 256; // frames per block (~6 s at 22.05 kHz)
  const PAD = KT; // extra context frames on each side
  const out = new Float32Array(x.length);
  const norm = new Float32Array(x.length);
  const totalFrames = Math.ceil(x.length / HOP);
  const scratch = new Float32Array(Math.max(KT, KF));

  for (let b0 = 0; b0 < totalFrames; b0 += BLOCK) {
    const f0 = Math.max(0, b0 - PAD), f1 = Math.min(totalFrames, b0 + BLOCK + PAD);
    const nf = f1 - f0;
    const RE = new Float32Array(nf * BINS), IM = new Float32Array(nf * BINS), MAG = new Float32Array(nf * BINS);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let f = 0; f < nf; f++) {
      const start = (f0 + f) * HOP - N / 2;
      for (let i = 0; i < N; i++) { const s = start + i; re[i] = s >= 0 && s < x.length ? x[s] * win[i] : 0; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < BINS; k++) {
        RE[f * BINS + k] = re[k]; IM[f * BINS + k] = im[k];
        MAG[f * BINS + k] = Math.hypot(re[k], im[k]);
      }
    }
    // only frames belonging to this block are reconstructed
    for (let f = b0 - f0; f < Math.min(nf, b0 - f0 + BLOCK); f++) {
      for (let k = 0; k < BINS; k++) {
        let c = 0;
        for (let t = f - (KT >> 1); t <= f + (KT >> 1); t++) scratch[c++] = MAG[Math.max(0, Math.min(nf - 1, t)) * BINS + k];
        const H = median(scratch, KT);
        c = 0;
        for (let q = k - (KF >> 1); q <= k + (KF >> 1); q++) scratch[c++] = MAG[f * BINS + Math.max(0, Math.min(BINS - 1, q))];
        const P = median(scratch, KF);
        const m = (H * H) / (H * H + P * P + 1e-12);
        re[k] = RE[f * BINS + k] * m; im[k] = IM[f * BINS + k] * m;
        if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      }
      // inverse FFT via conjugate trick
      for (let i = 0; i < N; i++) im[i] = -im[i];
      fft(re, im);
      const start = (f0 + f) * HOP - N / 2;
      for (let i = 0; i < N; i++) {
        const s = start + i;
        if (s < 0 || s >= x.length) continue;
        out[s] += (re[i] / N) * win[i];
        norm[s] += win[i] * win[i];
      }
    }
    onProgress(Math.min(1, (b0 + BLOCK) / totalFrames));
    await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
  }
  for (let i = 0; i < out.length; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out;
}
