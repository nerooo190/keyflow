// DX7 SysEx (.syx) support: parse 32-voice bulk dumps and single-voice dumps into voice objects,
// plus an original built-in "Keyflow FM" bank. Voice layout (unpacked, ops[0] = OP1 … ops[5] = OP6):
// { name, algorithm 0-31, feedback 0-7, oscSync, transpose (24 = C3), pegRates[4], pegLevels[4],
//   lfo:{speed, delay, pmd, amd, sync, wave, pms}, ops:[{rates[4], levels[4], bp, ld, rd, lc, rc, rs, ams, kvs, ol, mode, coarse, fine, detune}] }

const clean = (bytes) => String.fromCharCode(...bytes.map((b) => (b >= 32 && b < 127 ? b : 32))).trim() || 'INIT VOICE';

/** Unpack one 128-byte voice from a 32-voice bulk dump. */
function unpackPacked(d) {
  const ops = [];
  for (let i = 0; i < 6; i++) {
    const o = d.subarray(i * 17, i * 17 + 17);
    ops.unshift({ // stored OP6 first → unshift gives ops[0] = OP1
      rates: [o[0], o[1], o[2], o[3]], levels: [o[4], o[5], o[6], o[7]],
      bp: o[8], ld: o[9], rd: o[10], lc: o[11] & 3, rc: (o[11] >> 2) & 3,
      rs: o[12] & 7, detune: (o[12] >> 3) & 15, ams: o[13] & 3, kvs: (o[13] >> 2) & 7,
      ol: o[14], mode: o[15] & 1, coarse: (o[15] >> 1) & 31, fine: o[16],
    });
  }
  return {
    ops,
    pegRates: [d[102], d[103], d[104], d[105]], pegLevels: [d[106], d[107], d[108], d[109]],
    algorithm: d[110] & 31, feedback: d[111] & 7, oscSync: (d[111] >> 3) & 1,
    lfo: { speed: d[112], delay: d[113], pmd: d[114], amd: d[115], sync: d[116] & 1, wave: (d[116] >> 1) & 7, pms: (d[116] >> 4) & 7 },
    transpose: d[117], name: clean([...d.subarray(118, 128)]),
  };
}

/** Unpack a 155-byte single voice (VCED). */
function unpackSingle(d) {
  const ops = [];
  for (let i = 0; i < 6; i++) {
    const o = d.subarray(i * 21, i * 21 + 21);
    ops.unshift({
      rates: [o[0], o[1], o[2], o[3]], levels: [o[4], o[5], o[6], o[7]],
      bp: o[8], ld: o[9], rd: o[10], lc: o[11] & 3, rc: o[12] & 3, rs: o[13] & 7,
      ams: o[14] & 3, kvs: o[15] & 7, ol: o[16], mode: o[17] & 1, coarse: o[18] & 31, fine: o[19], detune: o[20] & 15,
    });
  }
  return {
    ops,
    pegRates: [d[126], d[127], d[128], d[129]], pegLevels: [d[130], d[131], d[132], d[133]],
    algorithm: d[134] & 31, feedback: d[135] & 7, oscSync: d[136] & 1,
    lfo: { speed: d[137], delay: d[138], pmd: d[139], amd: d[140], sync: d[141] & 1, wave: d[142] & 7, pms: d[143] & 7 },
    transpose: d[144], name: clean([...d.subarray(145, 155)]),
  };
}

/** Split raw bytes into SysEx messages (F0 … F7). */
export function splitSysex(bytes) {
  const msgs = [];
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) start = i;
    else if (bytes[i] === 0xf7 && start >= 0) { msgs.push(bytes.subarray(start, i + 1)); start = -1; }
  }
  return msgs;
}

/**
 * Parse a .syx file. Returns { voices: [...DX7 voices], other: [Uint8Array messages that are not DX7 voice data] }.
 * Also accepts headerless 4096-byte banks (some archives strip the SysEx frame).
 */
export function parseSyx(buffer) {
  const bytes = new Uint8Array(buffer);
  const voices = [], other = [];
  if (bytes.length === 4096 && bytes[0] !== 0xf0) {
    for (let v = 0; v < 32; v++) voices.push(unpackPacked(bytes.subarray(v * 128, v * 128 + 128)));
    return { voices, other };
  }
  const all = splitSysex(bytes);
  const reface = parseRefaceMessages(all);
  voices.push(...reface.voices);
  for (const m of all) {
    if (reface.used.has(m)) continue;
    const yamaha = m[1] === 0x43 && (m[2] & 0xf0) === 0x00;
    const format = m[3];
    if (yamaha && format === 0x09 && m.length >= 6 + 4096) {
      const data = m.subarray(6, 6 + 4096);
      for (let v = 0; v < 32; v++) voices.push(unpackPacked(data.subarray(v * 128, v * 128 + 128)));
    } else if (yamaha && format === 0x00 && m.length >= 6 + 155) {
      voices.push(unpackSingle(m.subarray(6, 6 + 155)));
    } else {
      other.push(m);
    }
  }
  return { voices, other };
}

/** Human-readable description of a non-voice SysEx message. */
export function describeSysex(m) {
  const id = m[1] === 0x00 ? `00 ${hex(m[2])} ${hex(m[3])}` : hex(m[1]);
  const maker = { 0x41: 'Roland', 0x43: 'Yamaha', 0x42: 'Korg', 0x44: 'Casio', 0x40: 'Kawai', 0x47: 'Akai', 0x7e: 'Universal (non-realtime)', 0x7f: 'Universal (realtime)' }[m[1]]
    || (m[1] === 0x00 ? 'Hersteller ' + id : 'Hersteller ' + id);
  let what = '';
  if (m[1] === 0x7e && m[3] === 0x09) what = m[4] === 1 ? 'GM System On' : m[4] === 3 ? 'GM2 System On' : 'GM Off';
  else if (m[1] === 0x41 && m[5] === 0x40 && m[6] === 0x00 && m[7] === 0x7f) what = 'GS Reset';
  else if (m[1] === 0x43 && m[3] === 0x4c && m[4] === 0 && m[5] === 0 && m[6] === 0x7e) what = 'XG System On';
  else if (m[1] === 0x7f && m[3] === 0x04 && m[4] === 0x01) what = 'Master Volume';
  else if (m[1] === 0x43 && m[3] === 0x7f && m[4] === 0x1c) what = 'reface DX ' + ({ 0x0e: 'Bulk Header', 0x0f: 'Bulk Footer', 0x30: 'Voice Common', 0x31: 'Operator ' + ((m[9] ?? 0) + 1), 0x00: 'System' }[m[8]] || 'Daten');
  return `${maker}${what ? ' – ' + what : ''} (${m.length} Bytes)`;
}
const hex = (b) => b.toString(16).padStart(2, '0').toUpperCase();

// ---------------- original built-in voices ("Keyflow FM") ----------------
function op({ r = [99, 50, 35, 60], l = [99, 85, 0, 0], ol = 99, coarse = 1, fine = 0, mode = 0, detune = 7, kvs = 2, rs = 1, ams = 0 } = {}) {
  return { rates: r, levels: l, bp: 39, ld: 0, rd: 0, lc: 0, rc: 0, rs, ams, kvs, ol, mode, coarse, fine, detune };
}
const OFF = { ol: 0 };
function voice(name, algorithm, feedback, ops, extra = {}) {
  return {
    name, algorithm: algorithm - 1, feedback, oscSync: 1, transpose: 24,
    pegRates: [99, 99, 99, 99], pegLevels: [50, 50, 50, 50],
    lfo: { speed: 35, delay: 0, pmd: 0, amd: 0, sync: 0, wave: 4, pms: 0 },
    ops: ops.map((o) => op(o)), ...extra,
  };
}

export const KEYFLOW_FM = [
  voice('KF E.PIANO', 5, 6, [
    { r: [96, 25, 25, 67], l: [99, 75, 0, 0], ol: 99, coarse: 1, kvs: 2 },
    { r: [95, 50, 35, 78], l: [99, 75, 0, 0], ol: 58, coarse: 14, kvs: 7 },
    { r: [95, 20, 20, 50], l: [99, 95, 0, 0], ol: 99, coarse: 1, detune: 6 },
    { r: [95, 29, 20, 50], l: [99, 95, 0, 0], ol: 86, coarse: 1, kvs: 6 },
    { r: [95, 20, 20, 50], l: [99, 95, 0, 0], ol: 82, coarse: 1, detune: 9 },
    { r: [95, 29, 20, 50], l: [99, 95, 0, 0], ol: 76, coarse: 1, kvs: 5 },
  ]),
  voice('GLASS BELL', 5, 3, [
    { r: [99, 28, 22, 40], l: [99, 70, 0, 0], ol: 99, coarse: 1 },
    { r: [99, 30, 25, 40], l: [99, 60, 0, 0], ol: 80, coarse: 3, fine: 50, kvs: 5 },
    { r: [99, 26, 20, 40], l: [99, 72, 0, 0], ol: 94, coarse: 2 },
    { r: [99, 33, 25, 40], l: [99, 55, 0, 0], ol: 74, coarse: 7, kvs: 6 },
    { r: [99, 24, 18, 40], l: [99, 70, 0, 0], ol: 86, coarse: 4, detune: 10 },
    { r: [99, 35, 25, 40], l: [99, 50, 0, 0], ol: 70, coarse: 11 },
  ]),
  voice('FM BASS', 16, 6, [
    { r: [99, 45, 30, 75], l: [99, 85, 0, 0], ol: 99, coarse: 0, kvs: 3 },
    { r: [99, 60, 40, 75], l: [99, 60, 0, 0], ol: 84, coarse: 0, kvs: 6 },
    { r: [99, 50, 35, 75], l: [99, 70, 0, 0], ol: 70, coarse: 1 },
    { r: [99, 70, 40, 75], l: [99, 40, 0, 0], ol: 60, coarse: 3 },
    { r: [99, 55, 35, 75], l: [99, 65, 0, 0], ol: 72, coarse: 1 },
    { r: [99, 70, 40, 75], l: [99, 50, 0, 0], ol: 66, coarse: 1 },
  ]),
  voice('DRAWBARS', 32, 0, [
    { r: [99, 99, 99, 80], l: [99, 99, 99, 0], ol: 92, coarse: 0, kvs: 0 },
    { r: [99, 99, 99, 80], l: [99, 99, 99, 0], ol: 99, coarse: 1, kvs: 0 },
    { r: [99, 99, 99, 80], l: [99, 99, 99, 0], ol: 88, coarse: 2, kvs: 0 },
    { r: [99, 99, 99, 80], l: [99, 99, 99, 0], ol: 84, coarse: 3, kvs: 0 },
    { r: [99, 99, 99, 80], l: [99, 99, 99, 0], ol: 80, coarse: 4, kvs: 0 },
    { r: [99, 99, 99, 80], l: [99, 99, 99, 0], ol: 74, coarse: 6, kvs: 0 },
  ], { lfo: { speed: 68, delay: 0, pmd: 6, amd: 0, sync: 0, wave: 4, pms: 3 } }),
  voice('SOFT PAD', 2, 5, [
    { r: [40, 30, 20, 30], l: [99, 92, 90, 0], ol: 96, coarse: 1, kvs: 1 },
    { r: [35, 30, 20, 30], l: [90, 80, 78, 0], ol: 70, coarse: 1, detune: 10 },
    { r: [42, 30, 20, 30], l: [99, 92, 90, 0], ol: 96, coarse: 1, detune: 4 },
    { r: [35, 30, 20, 30], l: [90, 80, 75, 0], ol: 68, coarse: 2 },
    { r: [30, 30, 20, 30], l: [90, 80, 75, 0], ol: 62, coarse: 1, detune: 11 },
    { r: [30, 30, 20, 30], l: [90, 80, 75, 0], ol: 58, coarse: 3 },
  ], { lfo: { speed: 30, delay: 40, pmd: 5, amd: 0, sync: 0, wave: 0, pms: 2 } }),
  voice('BRASSY', 22, 7, [
    { r: [70, 60, 40, 60], l: [99, 92, 88, 0], ol: 98, coarse: 1, kvs: 3 },
    { r: [62, 55, 35, 60], l: [99, 88, 80, 0], ol: 82, coarse: 1, kvs: 5 },
    { r: [72, 60, 40, 60], l: [99, 92, 88, 0], ol: 92, coarse: 1, detune: 9 },
    { r: [72, 60, 40, 60], l: [99, 92, 88, 0], ol: 90, coarse: 1, detune: 5 },
    { r: [72, 60, 40, 60], l: [99, 92, 88, 0], ol: 86, coarse: 2 },
    { r: [60, 50, 35, 60], l: [99, 85, 75, 0], ol: 78, coarse: 1, kvs: 4 },
  ]),
  voice('MARIMBA', 7, 0, [
    { r: [99, 45, 30, 60], l: [99, 0, 0, 0], ol: 99, coarse: 1 },
    { r: [99, 75, 50, 60], l: [99, 0, 0, 0], ol: 72, coarse: 4, kvs: 6 },
    { r: [99, 50, 35, 60], l: [99, 0, 0, 0], ol: 90, coarse: 1, detune: 9 },
    { r: [99, 80, 50, 60], l: [99, 0, 0, 0], ol: 64, coarse: 10, kvs: 6 },
    { r: [99, 80, 50, 60], l: [99, 0, 0, 0], ol: 56, coarse: 3 },
    OFF,
  ]),
  voice('SYNC LEAD', 16, 7, [
    { r: [92, 60, 50, 70], l: [99, 95, 92, 0], ol: 99, coarse: 1, kvs: 2 },
    { r: [90, 60, 50, 70], l: [99, 90, 86, 0], ol: 86, coarse: 1, kvs: 3 },
    { r: [90, 60, 50, 70], l: [99, 90, 86, 0], ol: 70, coarse: 2 },
    { r: [90, 60, 50, 70], l: [99, 90, 86, 0], ol: 60, coarse: 3 },
    { r: [90, 60, 50, 70], l: [99, 90, 86, 0], ol: 74, coarse: 1, detune: 10 },
    { r: [90, 60, 50, 70], l: [99, 90, 86, 0], ol: 80, coarse: 1 },
  ], { lfo: { speed: 62, delay: 55, pmd: 8, amd: 0, sync: 0, wave: 4, pms: 4 } }),
];

/** Encode voices into a standard 32-voice bulk dump (.syx) – lets users export the built-in bank. */
export function encodeBank(voices) {
  const data = new Uint8Array(4096);
  for (let v = 0; v < 32; v++) {
    const vc = voices[v % voices.length];
    const d = data.subarray(v * 128, v * 128 + 128);
    for (let i = 0; i < 6; i++) {
      const o = vc.ops[5 - i];
      const b = d.subarray(i * 17, i * 17 + 17);
      b.set([...o.rates, ...o.levels, o.bp, o.ld, o.rd, (o.lc & 3) | ((o.rc & 3) << 2), (o.rs & 7) | ((o.detune & 15) << 3),
        (o.ams & 3) | ((o.kvs & 7) << 2), o.ol, (o.mode & 1) | ((o.coarse & 31) << 1), o.fine]);
    }
    d.set([...vc.pegRates, ...vc.pegLevels, vc.algorithm & 31, (vc.feedback & 7) | ((vc.oscSync & 1) << 3),
      vc.lfo.speed, vc.lfo.delay, vc.lfo.pmd, vc.lfo.amd, (vc.lfo.sync & 1) | ((vc.lfo.wave & 7) << 1) | ((vc.lfo.pms & 7) << 4), vc.transpose], 102);
    const name = vc.name.padEnd(10).slice(0, 10);
    for (let i = 0; i < 10; i++) d[118 + i] = name.charCodeAt(i) & 0x7f;
  }
  let sum = 0;
  for (const b of data) sum += b;
  const out = new Uint8Array(4104);
  out.set([0xf0, 0x43, 0x00, 0x09, 0x20, 0x00]);
  out.set(data, 6);
  out[4102] = (128 - (sum & 127)) & 127;
  out[4103] = 0xf7;
  return out;
}

// ---------------- Yamaha reface DX (4-operator FM) ----------------
// Bulk dump per voice: header (addr 0E 0F 00), voice common (30 00 00, 38 bytes), 4 operators (31 0n 00, 28 bytes), footer (0F 0F 00).
// Message: F0 43 0n 7F 1C <count MSB> <count LSB> 05 <addr H M L> <data…> <checksum> F7

/** Routing of the 12 reface DX algorithms (1-based ops, same shape as the DX7 table in fm-processor.js). */
export const REFACE_ALGORITHMS = [
  { mods: { 3: [4], 2: [3], 1: [2] }, carriers: [1] },
  { mods: { 2: [4, 3], 1: [2] }, carriers: [1] },
  { mods: { 2: [3], 1: [2, 4] }, carriers: [1] },
  { mods: { 2: [4], 3: [4], 1: [2, 3] }, carriers: [1] },
  { mods: { 1: [2, 3, 4] }, carriers: [1] },
  { mods: { 3: [4], 2: [3] }, carriers: [1, 2] },
  { mods: { 3: [4], 2: [3], 1: [3] }, carriers: [1, 2] },
  { mods: { 1: [2], 3: [4] }, carriers: [1, 3] },
  { mods: { 1: [4], 2: [4], 3: [4] }, carriers: [1, 2, 3] },
  { mods: { 2: [4], 3: [4] }, carriers: [1, 2, 3] },
  { mods: { 3: [4] }, carriers: [1, 2, 3] },
  { mods: {}, carriers: [1, 2, 3, 4] },
];

const isReface = (m) => m[1] === 0x43 && (m[2] & 0xf0) === 0x00 && m[3] === 0x7f && m[4] === 0x1c && m[7] === 0x05 && m.length >= 13;
const sc = (v, max = 99) => Math.round((Math.min(127, v) / 127) * max);
const LFO_WAVE = [4, 0, 2, 1, 3, 5, 5]; // reface: sin, tri, saw up, saw down, square, S&H8, S&H → engine wave index

/** Convert raw reface data (common: 38 bytes, ops: 4×28 bytes) into a voice for the Keyflow FM engine. */
export function refaceToVoice(common, ops) {
  const name = clean([...common.slice(0, 10)]);
  const alg = Math.min(11, common[0x10]);
  const pegLevel = (v) => Math.max(0, Math.min(99, Math.round(50 + ((v - 64) / 48) * 50)));
  const engineOps = ops.map((o) => {
    const on = o[0] !== 0;
    const det = o[0x18] - 64; // -64…+63
    return {
      rates: [sc(o[1]), sc(o[2]), sc(o[3]), sc(o[4])], levels: [sc(o[5]), sc(o[6]), sc(o[7]), sc(o[8])],
      bp: 39, ld: sc(o[0x0a]), rd: sc(o[0x0b]), lc: o[0x0c] & 3, rc: o[0x0d] & 3, rs: sc(o[0x09], 7),
      ams: sc(o[0x0e], 3), kvs: sc(o[0x11], 7), ol: on ? sc(o[0x12]) : 0,
      mode: o[0x15] & 1, coarse: o[0x16] & 31, fine: Math.min(99, o[0x17]), detune: Math.max(0, Math.min(14, Math.round(7 + (det / 64) * 7))),
      pmdOn: o[0x0f] === 1, pegOn: o[0x10] === 1,
    };
  });
  while (engineOps.length < 6) engineOps.push({ rates: [99, 99, 99, 99], levels: [0, 0, 0, 0], bp: 39, ld: 0, rd: 0, lc: 0, rc: 0, rs: 0, ams: 0, kvs: 0, ol: 0, mode: 0, coarse: 1, fine: 0, detune: 7 });
  const anyAmd = ops.some((o) => o[0x0e] > 0);
  return {
    kind: 'reface',
    name,
    algorithm: alg,
    routing: REFACE_ALGORITHMS[alg],
    feedback: 0,
    fbOps: ops.map((o) => ({ level: o[0x13] / 127, square: o[0x14] === 1 })),
    oscSync: 1,
    transpose: 24 + (common[0x0c] - 64),
    pegRates: [sc(common[0x15]), sc(common[0x16]), sc(common[0x17]), sc(common[0x18])],
    pegLevels: [pegLevel(common[0x19]), pegLevel(common[0x1a]), pegLevel(common[0x1b]), pegLevel(common[0x1c])],
    lfo: { speed: sc(common[0x12]), delay: sc(common[0x13]), pmd: sc(common[0x14]), amd: anyAmd ? 99 : 0, sync: 0, wave: LFO_WAVE[common[0x11]] ?? 4, pms: common[0x14] ? 5 : 0 },
    ops: engineOps,
    raw: { common: [...common], ops: ops.map((o) => [...o]) }, // kept for lossless re-export
  };
}

/** Extract reface DX voices from a list of SysEx messages. Returns {voices, used:Set<message>} */
export function parseRefaceMessages(msgs) {
  const voices = [], used = new Set();
  let cur = null;
  const finish = () => {
    if (cur?.common && cur.ops.filter(Boolean).length === 4) voices.push(refaceToVoice(cur.common, cur.ops));
    cur = null;
  };
  for (const m of msgs) {
    if (!isReface(m)) continue;
    used.add(m);
    const [hi, mid, lo] = [m[8], m[9], m[10]];
    const data = m.subarray(11, m.length - 2);
    if (hi === 0x0e && mid === 0x0f) { finish(); cur = { common: null, ops: [] }; continue; }
    if (hi === 0x0f && mid === 0x0f) { finish(); continue; }
    cur ||= { common: null, ops: [] };
    if (hi === 0x30 && mid === 0x00 && lo === 0x00 && data.length >= 38) {
      if (cur.common && cur.ops.length) finish(), (cur = { common: null, ops: [] });
      cur.common = data.slice(0, 38);
    } else if (hi === 0x31 && mid <= 3 && data.length >= 28) cur.ops[mid] = data.slice(0, 28);
  }
  finish();
  return { voices, used };
}

function refaceMessage(addr, data, ch = 0) {
  const body = [0x05, ...addr, ...data];
  const count = body.length;
  let sum = 0;
  for (const b of body) sum += b;
  return [0xf0, 0x43, ch & 0x0f, 0x7f, 0x1c, (count >> 7) & 0x7f, count & 0x7f, ...body, (128 - (sum & 127)) & 127, 0xf7];
}

/** Encode reface voices (that carry their raw data) back into a reface DX .syx. */
export function encodeReface(voices) {
  const out = [];
  for (const v of voices) {
    if (!v.raw) continue;
    out.push(...refaceMessage([0x0e, 0x0f, 0x00], []));
    out.push(...refaceMessage([0x30, 0x00, 0x00], v.raw.common));
    v.raw.ops.forEach((o, i) => out.push(...refaceMessage([0x31, i, 0x00], o)));
    out.push(...refaceMessage([0x0f, 0x0f, 0x00], []));
  }
  return new Uint8Array(out);
}
