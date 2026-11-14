// Keyflow FM: 6-operator FM synthesizer (DX7-compatible voice parameters) as an AudioWorkletProcessor.
// Original implementation; algorithms follow the published DX7 operator routing diagrams.

// ALG[n] = [modulators per op (index 1..6), carriers, feedback op]
const A = (mods, carriers, fb) => ({ mods, carriers, fb });
const ALG = [
  A({ 1: [2], 3: [4], 4: [5], 5: [6] }, [1, 3], 6),
  A({ 1: [2], 3: [4], 4: [5], 5: [6] }, [1, 3], 2),
  A({ 1: [2], 2: [3], 4: [5], 5: [6] }, [1, 4], 6),
  A({ 1: [2], 2: [3], 4: [5], 5: [6] }, [1, 4], 6),
  A({ 1: [2], 3: [4], 5: [6] }, [1, 3, 5], 6),
  A({ 1: [2], 3: [4], 5: [6] }, [1, 3, 5], 6),
  A({ 1: [2], 3: [4, 5], 5: [6] }, [1, 3], 6),
  A({ 1: [2], 3: [4, 5], 5: [6] }, [1, 3], 4),
  A({ 1: [2], 3: [4, 5], 5: [6] }, [1, 3], 2),
  A({ 1: [2], 2: [3], 4: [5, 6] }, [1, 4], 3),
  A({ 1: [2], 2: [3], 4: [5, 6] }, [1, 4], 6),
  A({ 1: [2], 3: [4, 5, 6] }, [1, 3], 2),
  A({ 1: [2], 3: [4, 5, 6] }, [1, 3], 6),
  A({ 1: [2], 3: [4], 4: [5, 6] }, [1, 3], 6),
  A({ 1: [2], 3: [4], 4: [5, 6] }, [1, 3], 2),
  A({ 1: [2, 3, 5], 3: [4], 5: [6] }, [1], 6),
  A({ 1: [2, 3, 5], 3: [4], 5: [6] }, [1], 2),
  A({ 1: [2, 3, 4], 4: [5], 5: [6] }, [1], 3),
  A({ 1: [2], 2: [3], 4: [6], 5: [6] }, [1, 4, 5], 6),
  A({ 1: [3], 2: [3], 4: [5, 6] }, [1, 2, 4], 3),
  A({ 1: [3], 2: [3], 4: [6], 5: [6] }, [1, 2, 4, 5], 3),
  A({ 1: [2], 3: [6], 4: [6], 5: [6] }, [1, 3, 4, 5], 6),
  A({ 2: [3], 4: [6], 5: [6] }, [1, 2, 4, 5], 6),
  A({ 3: [6], 4: [6], 5: [6] }, [1, 2, 3, 4, 5], 6),
  A({ 4: [6], 5: [6] }, [1, 2, 3, 4, 5], 6),
  A({ 2: [3], 4: [5, 6] }, [1, 2, 4], 6),
  A({ 2: [3], 4: [5, 6] }, [1, 2, 4], 3),
  A({ 1: [2], 3: [4], 4: [5] }, [1, 3, 6], 5),
  A({ 3: [4], 5: [6] }, [1, 2, 3, 5], 6),
  A({ 3: [4], 4: [5] }, [1, 2, 3, 6], 5),
  A({ 5: [6] }, [1, 2, 3, 4, 5], 6),
  A({}, [1, 2, 3, 4, 5, 6], 6),
];

const TABLE = 4096;
const SIN = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SIN[i] = Math.sin((i / TABLE) * Math.PI * 2);
const sinCycles = (x) => { // x in cycles
  x -= Math.floor(x);
  const f = x * TABLE, i = f | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (f - i);
};

const dbToAmp = (db) => Math.pow(10, db / 20);
// DX7 levels 0..99 → dB (≈0.75 dB per step, 0 = silence)
const levelDb = (l) => (l <= 0 ? -120 : (l - 99) * 0.75);
// rate 0..99 → seconds for a full 0..99 sweep
const rateTime = (r) => 0.0015 + 38 * Math.pow(0.5, Math.min(99, Math.max(0, r)) / 6.2);
const MOD_DEPTH = 2.2; // modulation index scale (cycles at full level)
const CTRL = 16; // samples per control (envelope/LFO) update

class Env {
  // stages: 0→L1, 1→L2, 2→L3, 3 = hold at L3 until key up, 4 = release →L4, 5 = finished
  constructor(rates, levels, rateBoost) {
    this.rates = rates.map((r) => Math.min(99, r + rateBoost));
    this.levels = levels;
    this.level = levels[3]; // DX7 starts from L4
    this.stage = 0;
    this.released = false;
  }
  release() { if (!this.released) { this.released = true; this.stage = 4; } }
  step(dt) {
    if (this.stage === 3 || this.stage === 5) return this.level;
    const idx = this.stage === 4 ? 3 : this.stage;
    const target = this.levels[idx];
    const speed = (99 / rateTime(this.rates[idx])) * (target > this.level ? 2.2 : 1); // attacks faster
    const d = speed * dt;
    if (Math.abs(target - this.level) <= d) {
      this.level = target;
      this.stage = this.stage === 4 ? 5 : this.stage + 1; // 0→1→2→3(hold), 4→5
    } else this.level += Math.sign(target - this.level) * d;
    return this.level;
  }
}

function keyScaleDb(o, note) {
  const bpNote = o.bp + 21; // BP 39 = C3 (MIDI 60)
  const dist = (note - bpNote) / 12; // octaves
  if (dist === 0) return 0;
  const left = dist < 0;
  const depth = left ? o.ld : o.rd;
  const curve = left ? o.lc : o.rc; // 0 -LIN 1 -EXP 2 +EXP 3 +LIN
  if (!depth) return 0;
  const oct = Math.abs(dist);
  const shape = curve === 0 || curve === 3 ? Math.min(1, oct / 4) : Math.min(1, (Math.pow(2, oct) - 1) / 15);
  const db = shape * depth * 0.5;
  return curve <= 1 ? -db : Math.min(12, db);
}

class Voice {
  constructor(patch, note, vel, sr, id) {
    this.id = id; this.note = note; this.sr = sr; this.patch = patch; this.age = 0;
    // reface DX voices bring their own 4-op routing; DX7 voices use the 32-algorithm table
    const alg = patch.routing ? { ...patch.routing, fb: 0 } : ALG[patch.algorithm] || ALG[0];
    this.alg = alg;
    this.done = false;
    const tr = (patch.transpose ?? 24) - 24;
    const baseHz = 440 * Math.pow(2, (note + tr - 69) / 12);
    this.ops = patch.ops.map((o) => {
      let hz;
      if (o.mode) hz = Math.pow(10, o.coarse & 3) * Math.pow(10, o.fine / 100); // fixed frequency
      else hz = baseHz * (o.coarse === 0 ? 0.5 : o.coarse) * (1 + o.fine / 100);
      hz *= Math.pow(2, ((o.detune - 7) * 1.6) / 1200);
      const velDb = -o.kvs * 5.5 * (1 - vel / 127);
      const outDb = levelDb(o.ol) + velDb + keyScaleDb(o, note);
      const rateBoost = (o.rs * Math.max(0, note - 36)) / 10;
      return { inc: hz / sr, phase: patch.oscSync ? 0 : Math.random(), gain: o.ol ? dbToAmp(outDb) : 0, env: new Env(o.rates, o.levels, rateBoost), out: 0, prev: 0, amp: 0, ampTarget: 0, ams: o.ams,
        pegOn: o.pegOn !== false, pmdOn: o.pmdOn !== false };
    });
    this.peg = patch.pegLevels.every((l) => l === 50) ? null : new Env(patch.pegRates, patch.pegLevels, 0);
    this.fbGain = patch.feedback ? Math.pow(2, patch.feedback - 7) * 0.5 : 0;
    // reface DX: every operator has its own feedback (level 0..1, sawtooth or square character)
    this.fbOps = patch.fbOps ? patch.fbOps.map((f) => ({ gain: Math.pow(f.level, 1.6) * 0.8, square: f.square })) : null;
    const lf = patch.lfo || {};
    this.lfo = { hz: 0.06 + Math.pow((lf.speed || 0) / 99, 2.2) * 48, phase: lf.sync ? 0 : Math.random(), wave: lf.wave || 0,
      delay: (lf.delay || 0) / 99 * 3, pmd: (lf.pmd || 0) / 99, amd: (lf.amd || 0) / 99, pms: [0, 0.08, 0.15, 0.25, 0.5, 0.9, 1.6, 3][lf.pms || 0], sh: 0 };
    this.ctr = 0;
    this.pitchMul = 1; this.pegMul = 1; this.lfoMul = 1;
    this.lfoAmp = 0;
  }
  release() { for (const o of this.ops) o.env.release(); this.peg?.release(); }
  kill() { for (const o of this.ops) { o.env.rates[3] = 99; o.env.levels[3] = 0; o.env.release(); } }

  control(dt) {
    let alive = false;
    const l = this.lfo;
    l.phase += l.hz * dt * CTRL;
    if (l.phase >= 1) { l.phase -= 1; l.sh = Math.random() * 2 - 1; }
    const p = l.phase;
    const w = [1 - 4 * Math.abs(p - 0.5), 1 - 2 * p, 2 * p - 1, p < 0.5 ? 1 : -1, Math.sin(p * 2 * Math.PI), l.sh][l.wave] ?? 0;
    const fade = this.age < l.delay ? 0 : 1;
    const pegSemis = this.peg ? ((this.peg.step(dt * CTRL) - 50) / 50) * 48 : 0;
    this.pegMul = Math.pow(2, pegSemis / 12);
    this.lfoMul = Math.pow(2, (w * l.pmd * l.pms * fade * 12) / 12);
    this.pitchMul = this.pegMul * this.lfoMul;
    this.lfoAmp = (w * 0.5 + 0.5) * l.amd * fade;
    for (const o of this.ops) {
      const lev = o.env.step(dt * CTRL);
      if (o.env.stage !== 5 && lev > 0) alive = true;
      const amDb = o.ams ? -this.lfoAmp * [0, 6, 18, 36][o.ams] : 0;
      o.ampTarget = o.gain * dbToAmp(levelDb(lev) + amDb);
    }
    if (!alive && this.ops.every((o) => o.env.released)) this.done = true;
  }

  render(out, n, dt) {
    const ops = this.ops, alg = this.alg, mods = alg.mods, fbOp = alg.fb - 1;
    const carriers = alg.carriers, norm = 0.6 / Math.sqrt(carriers.length);
    for (let i = 0; i < n; i++) {
      if (this.ctr-- <= 0) { this.control(dt); this.ctr = CTRL - 1; this.age += dt * CTRL; }
      for (let k = 5; k >= 0; k--) {
        const o = ops[k];
        o.amp += (o.ampTarget - o.amp) * 0.08; // de-zipper
        if (o.amp < 1e-6 && o.ampTarget < 1e-6) { o.out = 0; continue; }
        let m = 0;
        const ms = mods[k + 1];
        if (ms) for (let j = 0; j < ms.length; j++) m += ops[ms[j] - 1].out;
        if (this.fbOps) {
          const f = this.fbOps[k];
          if (f && f.gain) m += f.square ? ((o.out + o.prev) * 0.5) ** 2 * 2 * f.gain : (o.out + o.prev) * 0.5 * f.gain; // square: even-symmetric feedback → hollow, square-like tone
        } else if (k === fbOp && this.fbGain) m += (o.out + o.prev) * 0.5 * this.fbGain;
        o.prev = o.out;
        o.phase += o.inc * (o.pegOn ? this.pegMul : 1) * (o.pmdOn ? this.lfoMul : 1);
        if (o.phase >= 1) o.phase -= Math.floor(o.phase);
        o.out = sinCycles(o.phase + m * MOD_DEPTH) * o.amp;
      }
      let s = 0;
      for (let c = 0; c < carriers.length; c++) s += ops[carriers[c] - 1].out;
      out[i] += s * norm;
    }
  }
}

class KeyflowFM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.patches = {}; // role → patch
    this.voices = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'patch') this.patches[m.role] = m.patch;
      else if (m.type === 'on') {
        const patch = this.patches[m.role] || this.patches.R;
        if (!patch) return;
        // same id retriggered → release old one
        for (const v of this.voices) if (v.id === m.id) v.release();
        if (this.voices.length >= 24) { // steal the oldest
          const oldest = this.voices.reduce((a, b) => (a.age > b.age ? a : b));
          this.voices.splice(this.voices.indexOf(oldest), 1);
        }
        this.voices.push(new Voice(patch, m.note, m.vel, sampleRate, m.id));
      } else if (m.type === 'off') {
        for (const v of this.voices) if (v.id === m.id) { v.release(); v.id = null; }
      } else if (m.type === 'allOff') {
        this.voices.forEach((v) => v.kill());
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    L.fill(0);
    const dt = 1 / sampleRate;
    for (const v of this.voices) v.render(L, L.length, dt);
    this.voices = this.voices.filter((v) => !v.done);
    for (let i = 0; i < L.length; i++) L[i] = Math.tanh(L[i]); // soft clip
    if (R !== L) R.set(L);
    return true;
  }
}

registerProcessor('keyflow-fm', KeyflowFM);
