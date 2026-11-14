// SoundFont engine: SF2, SF3, SFOGG and DLS via SpessaSynth (Apache-2.0), running in an AudioWorklet.
// Channel layout: 0 = song right hand, 1 = song left hand, 2 = your keys, 9 = drums (GM).
const LIB = 'https://esm.sh/spessasynth_lib@4.4.8?target=es2022';
const PROCESSOR = new URL('../vendor/spessasynth_processor.min.js', import.meta.url).href;

export const ROLE_CHANNEL = { R: 0, L: 1, user: 2 };

export const GM_FAMILIES = ['Piano', 'Chromatic Percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'Ethnic', 'Percussive', 'Sound Effects'];

export class SoundFontEngine {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.synth = null;
    this.bankId = null;
    this.presets = [];
    this.voices = new Map(); // key -> {ch, midi, timer}
  }

  async init() {
    if (this.synth) return;
    const lib = await import(LIB);
    await this.ctx.audioWorklet.addModule(PROCESSOR);
    this.synth = new lib.WorkletSynthesizer(this.ctx);
    this.synth.connect(this.output);
    await this.synth.isReady;
    this.synth.eventHandler.addEvent('presetListChange', 'keyflow', (list) => { this.presets = list || []; this.onPresets?.(this.presets); });
  }

  /** Load a sound bank (replaces the previous one). */
  async load(buffer, id) {
    await this.init();
    const mgr = this.synth.soundBankManager;
    await mgr.addSoundBank(buffer, id);
    for (const other of mgr.priorityOrder) if (other !== id) await mgr.deleteSoundBank(other);
    this.bankId = id;
    // presetList is filled asynchronously by the worklet
    for (let i = 0; i < 40 && !this.synth.presetList?.length; i++) await new Promise((r) => setTimeout(r, 50));
    this.presets = this.synth.presetList || this.presets;
    return this.presets;
  }

  /** Assign a preset {bankMSB, bankLSB, program, isDrum} to a role (R / L / user). */
  setPreset(role, preset) {
    if (!this.synth || !preset) return;
    const ch = ROLE_CHANNEL[role];
    const drum = !!preset.isDrum;
    // drum kits (GM/GS bank 128 or GM2/XG bank 120/127): switch the channel to drum mode, then select the kit
    if (this.synth.midiChannels?.[ch]?.setDrums) this.synth.midiChannels[ch].setDrums(drum);
    this.synth.controllerChange(ch, 0, preset.bankMSB || 0);
    this.synth.controllerChange(ch, 32, preset.bankLSB || 0);
    this.synth.programChange(ch, preset.program || 0);
  }

  play(midi, velocity, duration, key, role) {
    const ch = ROLE_CHANNEL[role] ?? 0;
    this.stop(key);
    this.synth.noteOn(ch, midi, Math.max(1, Math.min(127, Math.round(velocity * 127))));
    const v = { ch, midi, timer: null };
    if (duration != null) v.timer = setTimeout(() => this.stop(key), Math.max(60, duration * 1000));
    this.voices.set(key, v);
    return key;
  }

  stop(key) {
    const v = this.voices.get(key);
    if (!v) return false;
    clearTimeout(v.timer);
    this.voices.delete(key);
    // only release if no other voice holds the same note on this channel
    if (![...this.voices.values()].some((o) => o.ch === v.ch && o.midi === v.midi)) this.synth.noteOff(v.ch, v.midi);
    return true;
  }

  stopAll() {
    for (const v of this.voices.values()) clearTimeout(v.timer);
    this.voices.clear();
    this.synth?.stopAll(true);
  }
}
