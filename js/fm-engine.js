// Main-thread side of the Keyflow FM synth (DX7 .syx voices). Audio runs in fm-processor.js.
const PROCESSOR = new URL('./fm-processor.js', import.meta.url).href;

export class FMEngine {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.node = null;
    this.voices = [];
    this.keys = new Map(); // key → timer
  }

  async init() {
    if (this.node) return;
    await this.ctx.audioWorklet.addModule(PROCESSOR);
    this.node = new AudioWorkletNode(this.ctx, 'keyflow-fm', { numberOfInputs: 0, outputChannelCount: [2] });
    this.node.connect(this.output);
  }

  /** Load DX7 voices; returns a preset list compatible with the instrument pickers. */
  async load(voices, bankName = 'DX7') {
    await this.init();
    this.voices = voices;
    const group = `FM · ${bankName}`;
    return voices.map((v, i) => ({ name: v.name, program: i, bankMSB: 0, bankLSB: 0, isDrum: false, group }));
  }

  setPreset(role, preset) {
    const v = this.voices[preset?.program ?? 0];
    if (v) this.node?.port.postMessage({ type: 'patch', role, patch: v });
  }

  play(midi, velocity, duration, key, role) {
    this.stop(key);
    this.node.port.postMessage({ type: 'on', id: key, note: midi, vel: Math.max(1, Math.min(127, Math.round(velocity * 127))), role });
    this.keys.set(key, duration != null ? setTimeout(() => this.stop(key), Math.max(60, duration * 1000)) : null);
    return key;
  }

  stop(key) {
    if (!this.keys.has(key)) return false;
    clearTimeout(this.keys.get(key));
    this.keys.delete(key);
    this.node.port.postMessage({ type: 'off', id: key });
    return true;
  }

  stopAll() {
    for (const t of this.keys.values()) clearTimeout(t);
    this.keys.clear();
    this.node?.port.postMessage({ type: 'allOff' });
  }
}
