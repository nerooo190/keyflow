// Input sources: Web MIDI keyboards, computer keyboard, and microphone (acoustic piano) detection.
import { initMessages, keyMessages, lightChannels, protocol } from './lights.js';
export class InputHub {
  constructor() {
    this.listeners = new Set();
    this.midiAccess = null;
    this.midiDevices = [];
    this.kbOctave = 4;
    this.mic = null;
    this._kbDown = new Set();
    this._initKeyboard();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, p, v = 0.7, source = 'touch') { for (const fn of this.listeners) fn(type, p, v, source); }

  // ---------- Web MIDI ----------
  async enableMidi() {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not supported in this browser (use Chrome / Edge).');
    if (this.midiAccess) return this.midiDevices;
    // SysEx is needed for proprietary key-light protocols (Vangoa, Casio, ONE); fall back without it.
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
      this.sysex = true;
    } catch {
      this.midiAccess = await navigator.requestMIDIAccess();
      this.sysex = false;
    }
    const bind = () => {
      this.midiDevices = [];
      for (const input of this.midiAccess.inputs.values()) {
        this.midiDevices.push(input.name);
        input.onmidimessage = (e) => this._onMidi(e.data);
      }
      this._lit = new Map(); // a (re)connected device starts dark → resend everything
      this._lightInit = null;
      this.emit('devices', 0);
    };
    this.midiAccess.onstatechange = bind;
    bind();
    return this.midiDevices;
  }

  // ---------- MIDI out: light up keys on light-up / smart keyboards ----------
  outputs() { return this.midiAccess ? [...this.midiAccess.outputs.values()] : []; }

  /** [{id, name}] of available MIDI outputs. */
  outputList() { return this.outputs().map((o) => ({ id: o.id, name: o.name })); }

  /** Send one short MIDI message to a specific output ('all' = every output). */
  sendTo(outputId, msg) {
    const outs = outputId === 'all' ? this.outputs() : this.outputs().filter((o) => o.id === outputId);
    for (const o of outs) { try { o.send(msg); } catch (e) { console.warn('MIDI send failed', e); } }
  }

  _send(msgs) {
    const outs = this.outputs();
    for (const m of msgs) {
      if (m[0] === 0xf0 && !this.sysex) continue; // browser refused SysEx permission
      for (const o of outs) { try { o.send(m); } catch (e) { console.warn('MIDI send failed', e); } }
    }
  }

  /**
   * Light exactly the given keys using a key-light protocol; only changes are sent.
   * @param {Map<number,{h?:string,f?:number}>} wanted  pitch → hand/finger info
   * @param {string} proto  protocol id from lights.js
   */
  setLights(wanted, proto = 'off', opts = {}) {
    if (!this.outputs().length) return;
    if (!this._lit) this._lit = new Map();
    if (this._lightProto !== proto) {
      // switch protocol: turn everything off with the old one, then initialise the new one
      for (const [p, info] of this._lit) this._send(keyMessages(this._lightProto, p, false, info));
      this._lit = new Map();
      this._lightProto = proto;
      this._lightInit = null;
    }
    if (proto === 'off') return;
    const initKey = proto + (opts.silent === false ? ':loud' : '');
    if (this._lightInit !== initKey) { this._send(initMessages(proto, opts)); this._lightInit = initKey; }
    this.lightChs = lightChannels(proto);
    for (const [p, info] of this._lit) {
      if (!wanted.has(p)) { this._send(keyMessages(proto, p, false, info)); this._lit.delete(p); }
    }
    for (const [p, info] of wanted) {
      if (!this._lit.has(p)) { this._send(keyMessages(proto, p, true, info)); this._lit.set(p, info); }
    }
  }

  clearLights() {
    if (this._lightProto) this.setLights(new Map(), this._lightProto);
  }

  /** Send raw SysEx messages (arrays starting with F0) to all MIDI outputs. */
  async sendSysex(messages) {
    await this.enableMidi();
    if (!this.sysex) throw new Error('Chrome hat SysEx nicht erlaubt – Berechtigung „MIDI-Geräte steuern“ zulassen.');
    if (!this.outputs().length) throw new Error('Kein MIDI-Gerät verbunden.');
    for (const m of messages) { this._send([m]); await new Promise((r) => setTimeout(r, 20)); } // small gap for slow devices
    return this.outputs().map((o) => o.name);
  }

  /** Run a light chase over one octave so the user can check the protocol works. */
  async testLights(proto, opts = {}) {
    const notes = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
    for (const p of notes) {
      this.setLights(new Map([[p, { h: p < 66 ? 'L' : 'R', f: 1 + (p % 5) }]]), proto, opts);
      await new Promise((r) => setTimeout(r, 180));
    }
    this.setLights(new Map(), proto, opts);
  }

  _onMidi([status, d1, d2]) {
    const cmd = status & 0xf0;
    // ignore echoes of our own channel-based light notes
    if (this.lightChs?.has(status & 0x0f) && this._lit?.has(d1) && (status & 0xe0) === 0x80) return;
    if (cmd === 0x90 && d2 > 0) this.emit('on', d1, d2 / 127, 'midi');
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.emit('off', d1, 0, 'midi');
  }

  // ---------- Computer keyboard ----------
  _initKeyboard() {
    const map = 'awsedftgyhujkolp;\''; // C C# D D# E F F# G G# A A# B C C# D D# E F
    window.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, textarea')) return;
      if (!this.keyboardEnabled) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { this.kbOctave = Math.max(1, this.kbOctave - 1); return; }
      if (k === 'x') { this.kbOctave = Math.min(7, this.kbOctave + 1); return; }
      const i = map.indexOf(k);
      if (i < 0 || e.repeat || e.ctrlKey || e.metaKey) return;
      const p = (this.kbOctave + 1) * 12 + i;
      this._kbDown.add(k + p);
      e.preventDefault();
      this.emit('on', p, 0.75, 'keyboard');
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      for (const id of [...this._kbDown]) {
        if (id.startsWith(k) && /^\d+$/.test(id.slice(k.length))) {
          this._kbDown.delete(id);
          this.emit('off', parseInt(id.slice(k.length), 10), 0, 'keyboard');
        }
      }
    });
  }

  // ---------- Microphone ----------
  async enableMic(sensitivity = 0.5) {
    if (this.mic) return;
    this.mic = new MicDetector((type, p, v) => this.emit(type, p, v, 'mic'), sensitivity);
    try {
      await this.mic.start();
    } catch (e) {
      this.mic = null;
      throw e;
    }
  }

  disableMic() {
    if (this.mic) this.mic.stop();
    this.mic = null;
  }
}

/**
 * Lightweight polyphonic note detector: harmonic-sum salience over an FFT,
 * with onset detection and octave/harmonic suppression. Works best with a
 * real acoustic or digital piano and the app sound muted (or headphones).
 */
class MicDetector {
  constructor(cb, sensitivity) {
    this.cb = cb;
    this.sensitivity = sensitivity;
    this.active = new Map(); // p -> last salience
    this.history = new Float32Array(128);
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 8192;
    this.an.smoothingTimeConstant = 0;
    src.connect(this.an);
    this.spec = new Float32Array(this.an.frequencyBinCount);
    this.time = new Float32Array(this.an.fftSize);
    this.binHz = this.ctx.sampleRate / this.an.fftSize;
    this.timer = setInterval(() => this.tick(), 30);
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }

  mag(f) {
    const b = f / this.binHz;
    const i = Math.round(b);
    let m = 0;
    for (let k = i - 1; k <= i + 1; k++) if (k > 0 && k < this.spec.length) m = Math.max(m, this.spec[k]);
    return m;
  }

  tick() {
    this.an.getFloatTimeDomainData(this.time);
    let rms = 0;
    for (const x of this.time) rms += x * x;
    rms = Math.sqrt(rms / this.time.length);
    this.an.getFloatFrequencyData(this.spec);
    for (let i = 0; i < this.spec.length; i++) this.spec[i] = Math.pow(10, this.spec[i] / 20);

    const gate = 0.004 + (1 - this.sensitivity) * 0.03;
    const sal = new Float32Array(128);
    let maxS = 0;
    if (rms > gate) {
      for (let p = 36; p <= 96; p++) {
        const f0 = 440 * Math.pow(2, (p - 69) / 12);
        let s = 0;
        for (let h = 1; h <= 5; h++) s += this.mag(f0 * h) / Math.sqrt(h);
        // penalise if the sub-octave carries strong energy (we are probably a harmonic)
        sal[p] = s;
        if (s > maxS) maxS = s;
      }
    }

    const thresh = maxS * (0.55 - this.sensitivity * 0.2);
    const detected = [];
    for (let p = 36; p <= 96; p++) {
      const s = sal[p];
      if (s > 0 && s >= thresh && s >= sal[p - 1] && s >= sal[p + 1]) detected.push(p);
    }
    detected.sort((a, b) => sal[b] - sal[a]);
    const keep = new Set();
    for (const p of detected) {
      if ([12, 19, 24, 28].some((iv) => keep.has(p - iv))) continue;
      keep.add(p);
      if (keep.size >= 6) break;
    }

    for (const p of keep) {
      const prev = this.history[p];
      const onset = !this.active.has(p) || sal[p] > prev * 1.8;
      if (onset) {
        if (this.active.has(p)) this.cb('off', p, 0);
        this.active.set(p, sal[p]);
        this.cb('on', p, Math.min(1, rms * 8));
      }
    }
    for (const p of [...this.active.keys()]) {
      if (!keep.has(p) && sal[p] < this.active.get(p) * 0.3) {
        this.active.delete(p);
        this.cb('off', p, 0);
      }
    }
    this.history = sal;
  }
}

export const inputs = new InputHub();
