// Piano sound: Salamander Grand Piano samples (CC-BY 3.0) streamed lazily, with a synth fallback.
const BASE = 'https://tonejs.github.io/audio/salamander/';
const SAMPLE_NAMES = ['C', 'Ds', 'Fs', 'A'];
const SAMPLE_PCS = [0, 3, 6, 9];

export class PianoAudio {
  constructor() {
    this.ctx = null;
    this.samples = new Map(); // midi -> AudioBuffer
    this.voices = new Map(); // key -> {src, gain}
    this.volume = 0.8;
    this.loading = null;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      this.master.connect(comp).connect(this.ctx.destination);
      this.load();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  load() {
    if (this.loading) return this.loading;
    const jobs = [];
    for (let oct = 0; oct <= 7; oct++) {
      SAMPLE_NAMES.forEach((n, i) => {
        const midi = (oct + 1) * 12 + SAMPLE_PCS[i];
        if (midi < 21 || midi > 108) return;
        jobs.push(
          fetch(`${BASE}${n}${oct}.mp3`)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
            .then((b) => this.ctx.decodeAudioData(b))
            .then((buf) => this.samples.set(midi, buf))
            .catch(() => {}),
        );
      });
    }
    this.loading = Promise.all(jobs);
    return this.loading;
  }

  nearest(midi) {
    let best = null, bd = 99;
    for (const k of this.samples.keys()) {
      const d = Math.abs(k - midi);
      if (d < bd) { bd = d; best = k; }
    }
    return bd <= 6 ? best : null;
  }

  // ---------- sound source switching (Salamander piano / SoundFont / SFZ) ----------
  /** Activate a sound bank from the library. Returns the preset list (SoundFonts) or null. */
  async setBank(id, onProgress = () => {}) {
    this.ensure();
    this.stopAll();
    if (!id || id === 'piano') { this.alt = null; this.bankId = 'piano'; return null; }
    const { loadBankData } = await import('./soundlib.js');
    const data = await loadBankData(id, (p) => onProgress('Lade Sound-Bibliothek …', p));
    if (data.type === 'dx7') {
      if (!this.fm) {
        const { FMEngine } = await import('./fm-engine.js');
        this.fm = new FMEngine(this.ctx, this.master);
      }
      const presets = await this.fm.load(data.voices, data.name);
      this.alt = this.fm;
      this.bankId = id;
      return presets;
    }
    if (data.type === 'sf') {
      if (!this.sf) {
        const { SoundFontEngine } = await import('./sf-engine.js');
        this.sf = new SoundFontEngine(this.ctx, this.master);
      }
      onProgress('Initialisiere Synthesizer …', null);
      const presets = await this.sf.load(data.buffer, id);
      this.alt = this.sf;
      this.bankId = id;
      return presets;
    }
    const { SfzEngine } = await import('./sfz.js');
    const eng = new SfzEngine(this.ctx, this.master, data.files, data.sfzPath);
    this.sfzInfo = await eng.load((p) => onProgress('Lade SFZ-Samples …', p));
    this.alt = eng;
    this.bankId = id;
    return null;
  }

  /** Choose the instrument (SoundFont preset) for a role: 'R' | 'L' | 'user'. */
  setRolePreset(role, preset) {
    this.alt?.setPreset?.(role, preset);
  }

  /**
   * External MIDI routing (VST3 host / DAW / hardware synth).
   * fn(role) → { send(msg), channel, exclusive } | null
   */
  setExternalRoute(fn) { this.extRoute = fn; }

  playExternal(ext, midi, velocity, duration, key) {
    this.stopExternal(key);
    ext.send([0x90 | ext.channel, midi, Math.max(1, Math.min(127, Math.round(velocity * 127)))]);
    const timer = duration != null ? setTimeout(() => this.stopExternal(key), Math.max(60, duration * 1000)) : null;
    (this.extKeys ||= new Map()).set(key, { ext, midi, timer });
    (this.extChannels ||= new Map()).set(ext.channel, ext.send);
  }

  stopExternal(key) {
    const e = this.extKeys?.get(key);
    if (!e) return false;
    clearTimeout(e.timer);
    this.extKeys.delete(key);
    e.ext.send([0x80 | e.ext.channel, e.midi, 0]);
    return true;
  }

  /** Start a note. role: 'R' | 'L' (song hands) | 'user' (your keys). Returns a key for stop(). */
  play(midi, velocity = 0.7, duration = null, key = null, role = 'R') {
    const ext = this.extRoute?.(role);
    if (ext) {
      key = key ?? `${midi}:${Math.random()}`;
      this.playExternal(ext, midi, velocity, duration, key);
      if (ext.exclusive) return key; // only the external instrument sounds
    }
    if (this.alt) {
      this.ensure();
      key = key ?? `${midi}:${Math.random()}`;
      return this.alt.play(midi, velocity, duration, key, role);
    }
    return this.playPiano(midi, velocity, duration, key);
  }

  playPiano(midi, velocity = 0.7, duration = null, key = null) {
    const ctx = this.ensure();
    const now = ctx.currentTime;
    key = key ?? `${midi}:${Math.random()}`;
    this.stop(key);
    const gain = ctx.createGain();
    const vel = Math.max(0.05, Math.min(1, velocity));
    gain.connect(this.master);
    let src;
    const base = this.nearest(midi);
    if (base != null) {
      src = ctx.createBufferSource();
      src.buffer = this.samples.get(base);
      src.playbackRate.value = Math.pow(2, (midi - base) / 12);
      gain.gain.setValueAtTime(vel * vel * 1.4, now);
      src.connect(gain);
    } else {
      // Fallback synth: two detuned oscillators with a decaying envelope.
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      src = ctx.createOscillator();
      src.type = 'triangle';
      src.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2.001;
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      o2.connect(g2).connect(gain);
      src.connect(gain);
      o2.start(now);
      src._extra = o2;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(vel * 0.35, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(vel * 0.05, now + 2.5);
    }
    src.start(now);
    const voice = { src, gain };
    this.voices.set(key, voice);
    if (duration != null) setTimeout(() => this.stop(key), Math.max(80, duration * 1000));
    return key;
  }

  stop(key, release = 0.25) {
    this.stopExternal(key);
    if (this.alt?.stop(key)) return;
    const v = this.voices.get(key);
    if (!v) return;
    this.voices.delete(key);
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.setTargetAtTime(0, t, release / 3);
    v.src.stop(t + release + 0.1);
    if (v.src._extra) v.src._extra.stop(t + release + 0.1);
  }

  stopAll() {
    for (const k of [...(this.extKeys?.keys() || [])]) this.stopExternal(k);
    for (const [ch, send] of this.extChannels || []) send([0xb0 | ch, 123, 0]); // All Notes Off
    this.alt?.stopAll();
    for (const k of [...this.voices.keys()]) this.stop(k, 0.08);
  }

  click(accent) {
    const ctx = this.ensure();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.06);
  }
}

export const piano = new PianoAudio();
