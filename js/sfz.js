// SFZ support: parser (headers, inheritance, #define, #include) + Web Audio sampler.
// Supported opcodes: sample, default_path, lokey/hikey/key, pitch_keycenter, lovel/hivel, tune, transpose,
// pitch_keytrack, volume, amp_veltrack, pan, offset, ampeg_attack/hold/decay/sustain/release,
// loop_mode, loop_start/loop_end (loopstart/loopend), trigger (attack/release), seq_length/seq_position,
// lorand/hirand, note_offset, octave_offset, group/off_by (simple choke).

const NOTE_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function sfzKey(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  const m = /^([a-g])(#|b|♯|♭)?(-?\d+)$/.exec(s);
  if (!m) return null;
  let pc = NOTE_PC[m[1]];
  if (m[2] === '#' || m[2] === '♯') pc++;
  if (m[2] === 'b' || m[2] === '♭') pc--;
  return (parseInt(m[3], 10) + 1) * 12 + pc; // SFZ: c4 = 60
}

const norm = (p) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
function joinPath(dir, rel) {
  const parts = (dir ? dir + '/' + rel : rel).split('/');
  const out = [];
  for (const x of parts) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x); }
  return out.join('/');
}

/**
 * Parse SFZ text into regions with fully inherited opcodes.
 * @param {string} text
 * @param {(path:string)=>string|null} readText for #include
 */
export function parseSfz(text, readText = () => null, depth = 0) {
  // strip comments
  text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // #include
  text = text.replace(/#include\s+"([^"]+)"/g, (_, p) => (depth < 8 ? readText(norm(p)) || '' : ''));
  // #define $VAR value
  const defs = {};
  text = text.replace(/#define\s+(\$\w+)\s+(\S+)/g, (_, k, v) => { defs[k] = v; return ''; });
  for (const [k, v] of Object.entries(defs).sort((a, b) => b[0].length - a[0].length)) text = text.split(k).join(v);

  const control = {}, global = {}, master = {}, group = {};
  const regions = [];
  let scope = null;
  // split into header tokens and bodies
  const re = /<(\w+)>/g;
  let m, last = 0, header = null;
  const flush = (body) => {
    if (!header) return;
    const ops = parseOps(body);
    if (header === 'control') Object.assign(control, ops);
    else if (header === 'global') { Object.assign(global, ops); }
    else if (header === 'master') { for (const k in master) delete master[k]; Object.assign(master, ops); for (const k in group) delete group[k]; }
    else if (header === 'group') { for (const k in group) delete group[k]; Object.assign(group, ops); }
    else if (header === 'region') regions.push({ ...global, ...master, ...group, ...ops });
  };
  while ((m = re.exec(text))) {
    flush(text.slice(last, m.index));
    header = m[1].toLowerCase();
    last = re.lastIndex;
    scope = header;
  }
  flush(text.slice(last));
  return { control, regions, scope };
}

function parseOps(body) {
  const ops = {};
  // opcode=value, value may contain spaces until the next "name=" token
  const re = /([A-Za-z_][\w]*)=/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ key: m[1].toLowerCase(), start: m.index, valStart: re.lastIndex });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    ops[mk.key] = body.slice(mk.valStart, end).trim();
  });
  return ops;
}

const num = (v, d) => (v == null || v === '' || isNaN(+v) ? d : +v);

/** Build playable region descriptors (numbers resolved, sample paths absolute in the bank). */
export function compileRegions(parsed, sfzDir) {
  const { control, regions } = parsed;
  const defPath = norm(control.default_path || '');
  const noteOffset = num(control.note_offset, 0) + num(control.octave_offset, 0) * 12;
  return regions.filter((r) => r.sample && !/^\*/.test(r.sample)).map((r) => {
    const key = sfzKey(r.key);
    const lokey = sfzKey(r.lokey) ?? key ?? 0;
    const hikey = sfzKey(r.hikey) ?? key ?? 127;
    return {
      sample: joinPath(sfzDir, joinPath(defPath, norm(r.sample))),
      lokey: lokey + noteOffset, hikey: hikey + noteOffset,
      center: (sfzKey(r.pitch_keycenter) ?? key ?? lokey) + noteOffset,
      lovel: num(r.lovel, 1), hivel: num(r.hivel, 127),
      tune: num(r.tune, 0), transpose: num(r.transpose, 0), keytrack: num(r.pitch_keytrack, 100),
      volume: num(r.volume, 0), veltrack: num(r.amp_veltrack, 100), pan: num(r.pan, 0),
      offset: num(r.offset, 0),
      attack: num(r.ampeg_attack, 0.002), hold: num(r.ampeg_hold, 0), decay: num(r.ampeg_decay, 0),
      sustain: num(r.ampeg_sustain, 100) / 100, release: num(r.ampeg_release, 0.05),
      loopMode: (r.loop_mode || r.loopmode || '').toLowerCase(),
      loopStart: num(r.loop_start ?? r.loopstart, null), loopEnd: num(r.loop_end ?? r.loopend, null),
      trigger: (r.trigger || 'attack').toLowerCase(),
      seqLength: num(r.seq_length, 1), seqPosition: num(r.seq_position, 1),
      lorand: num(r.lorand, 0), hirand: num(r.hirand, 1),
      group: num(r.group, 0), offBy: num(r.off_by, 0),
    };
  });
}

export class SfzEngine {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} output
   * @param {Map<string, Blob>} files  path (lower-case, '/') → Blob
   * @param {string} sfzPath path of the .sfz inside `files`
   */
  constructor(ctx, output, files, sfzPath) {
    this.ctx = ctx;
    this.output = output;
    this.files = files;
    this.sfzPath = sfzPath;
    this.buffers = new Map(); // sample path → Promise<AudioBuffer|null>
    this.voices = new Map(); // key → [{src, gain, region}]
    this.seq = 0;
  }

  async load(onProgress = () => {}) {
    const read = async (p) => { const b = this.files.get(p.toLowerCase()); return b ? b.text() : null; };
    const dir = this.sfzPath.includes('/') ? this.sfzPath.slice(0, this.sfzPath.lastIndexOf('/')) : '';
    const text = await read(this.sfzPath);
    if (text == null) throw new Error('SFZ file missing: ' + this.sfzPath);
    // pre-read includes (sync reader needed by the parser)
    const includes = {};
    for (const m of text.matchAll(/#include\s+"([^"]+)"/g)) includes[norm(m[1])] = await read(joinPath(dir, norm(m[1])));
    const parsed = parseSfz(text, (p) => includes[p] ?? null);
    this.regions = compileRegions(parsed, dir);
    if (!this.regions.length) throw new Error('No playable regions in ' + this.sfzPath);
    const missing = [...new Set(this.regions.map((r) => r.sample))].filter((p) => !this.files.has(p.toLowerCase()));
    this.missing = missing;
    // decode all samples (limited concurrency) so playback is instant
    const paths = [...new Set(this.regions.map((r) => r.sample))].filter((p) => this.files.has(p.toLowerCase()));
    let done = 0;
    const queue = [...paths];
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift();
        await this.buffer(p);
        onProgress(++done / paths.length);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return { regions: this.regions.length, samples: paths.length, missing: missing.length };
  }

  buffer(path) {
    if (!this.buffers.has(path)) {
      const blob = this.files.get(path.toLowerCase());
      this.buffers.set(path, blob ? blob.arrayBuffer().then((ab) => this.ctx.decodeAudioData(ab)).catch(() => null) : Promise.resolve(null));
    }
    return this.buffers.get(path);
  }

  match(midi, vel127, trigger) {
    const rnd = Math.random();
    this.seq++;
    return this.regions.filter((r) => r.trigger === trigger && midi >= r.lokey && midi <= r.hikey && vel127 >= r.lovel && vel127 <= r.hivel
      && rnd >= r.lorand && rnd < r.hirand && (r.seqLength <= 1 || ((this.seq - 1) % r.seqLength) + 1 === r.seqPosition));
  }

  async start(r, midi, vel127, when) {
    const buf = await this.buffer(r.sample);
    if (!buf) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const cents = (midi - r.center) * r.keytrack + r.transpose * 100 + r.tune;
    src.playbackRate.value = Math.pow(2, cents / 1200);
    if (r.loopMode === 'loop_continuous' || r.loopMode === 'loop_sustain') {
      if (r.loopStart != null && r.loopEnd != null && r.loopEnd > r.loopStart) {
        src.loop = true;
        src.loopStart = r.loopStart / buf.sampleRate;
        src.loopEnd = r.loopEnd / buf.sampleRate;
      }
    }
    const velGain = 1 - (r.veltrack / 100) * (1 - Math.pow(vel127 / 127, 2));
    const peak = Math.pow(10, r.volume / 20) * velGain;
    const g = ctx.createGain();
    const t = Math.max(when, ctx.currentTime);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, r.attack));
    if (r.decay > 0) g.gain.setTargetAtTime(peak * r.sustain, t + r.attack + r.hold, r.decay / 3);
    let node = g;
    if (r.pan) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, r.pan / 100)); g.connect(p); node = p; }
    node.connect(this.output);
    src.connect(g);
    src.start(t, r.offset / buf.sampleRate);
    return { src, gain: g, region: r };
  }

  play(midi, velocity, duration, key) {
    const vel127 = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    this.stop(key, true);
    const regions = this.match(midi, vel127, 'attack');
    // choke groups (e.g. hi-hat): regions with off_by kill voices of that group
    for (const r of regions) {
      if (!r.group) continue;
      for (const [k, vs] of this.voices) if (vs.some((v) => v.region.offBy === r.group)) this.stop(k, true);
    }
    const entry = { midi, vel127, voices: [], timer: null };
    this.voices.set(key, entry);
    regions.forEach((r) => this.start(r, midi, vel127, this.ctx.currentTime).then((v) => { if (v) { if (this.voices.get(key) === entry) entry.voices.push(v); else this.release(v); } }));
    if (duration != null) entry.timer = setTimeout(() => this.stop(key), Math.max(60, duration * 1000));
    return key;
  }

  release(v, fast = false) {
    if (v.region.loopMode === 'one_shot' && !fast) return;
    const t = this.ctx.currentTime;
    const rel = fast ? 0.03 : Math.max(0.03, v.region.release);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.setTargetAtTime(0, t, rel / 4);
    try { v.src.stop(t + rel + 0.05); } catch {}
  }

  stop(key, fast = false) {
    const e = this.voices.get(key);
    if (!e) return false;
    clearTimeout(e.timer);
    this.voices.delete(key);
    e.voices.forEach((v) => this.release(v, fast));
    if (!fast) for (const r of this.match(e.midi, e.vel127, 'release')) this.start(r, e.midi, e.vel127, this.ctx.currentTime);
    return true;
  }

  stopAll() {
    for (const k of [...this.voices.keys()]) this.stop(k, true);
  }
}
