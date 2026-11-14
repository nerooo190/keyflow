// Sound library: built-in banks + imported SoundFonts (stored in IndexedDB).
// Formats: .sf2 .sf3 .sfogg .dls (SpessaSynth) · .sfz + samples (wav/flac/ogg/mp3/aif) as files, folder or .zip.
import { uid } from './util.js';
import { parseSyx, describeSysex, KEYFLOW_FM } from './dx7.js';

export const GM_BANK = {
  id: 'gm-generaluser',
  name: 'GeneralUser GS – alle 128 GM-Instrumente + Drums',
  type: 'sf',
  url: 'https://cdn.jsdelivr.net/gh/spessasus/SpessaSynth@master/soundfonts/GeneralUserGS.sf3',
  size: 8423728,
  builtin: true,
};
export const PIANO_BANK = { id: 'piano', name: 'Konzertflügel (Salamander Grand)', type: 'piano', builtin: true };
export const FM_BANK = { id: 'dx7-keyflow', name: 'Keyflow FM – DX7-kompatibler Synth (8 Sounds)', type: 'dx7', format: 'SYX', builtin: true };

const SF_EXT = /\.(sf2|sf3|sfogg|dls|sf2pack)$/i;
const SAMPLE_EXT = /\.(wav|flac|ogg|oga|mp3|aif|aiff|m4a|opus)$/i;
const UNSUPPORTED = /\.(gig|nki|nkm|nkx|nicnt|exs|h2p|kmp|akp|sxt|ens|xpm|nkc)$/i;
export const ACCEPT = '.sf2,.sf3,.sfogg,.dls,.sf2pack,.sfz,.syx,.zip,.wav,.flac,.ogg,.mp3,.aif,.aiff';

// ---------- IndexedDB ----------
let dbp;
function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('keyflow-sounds', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('banks', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('banks', mode);
    const q = fn(t.objectStore('banks'));
    t.oncomplete = () => res(q?.result);
    t.onerror = () => rej(t.error);
  });
}
const getBank = (id) => tx('readonly', (s) => s.get(id));
// sync hooks (set by sync.js)
let onBankChange = null, blobFetcher = null;
export const setOnBankChange = (fn) => (onBankChange = fn);
export const setBlobFetcher = (fn) => (blobFetcher = fn);

/** Store a bank. touch=true marks it changed (sync pushes it); false is used for synced copies. */
const putBank = async (b, touch = true) => {
  const local = b.cacheOf || String(b.id).startsWith('cache:');
  if (touch && !local) b.updatedAt = Date.now();
  const r = await tx('readwrite', (s) => s.put(b));
  if (touch && !local) onBankChange?.(b);
  return r;
};
/** Deleting keeps a tombstone so the deletion reaches the account and other devices. */
export const deleteBank = async (id) => {
  const b = await getBank(id);
  await putBank({ id, deleted: true, type: b?.type, name: b?.name, created: b?.created || Date.now() });
};
/** Raw records for sync (no local caches). */
export async function allBankRecords() {
  return ((await tx('readonly', (s) => s.getAll())) || []).filter((b) => !b.cacheOf && !String(b.id).startsWith('cache:'));
}
export const putSyncedBank = (b) => putBank(b, false);

async function ensureBlobs(b, onProgress) {
  if (b.type === 'sf' && !b.blob && b.blobHash) {
    if (!blobFetcher) throw new Error('Diese Bibliothek liegt in deinem Konto – bitte anmelden.');
    onProgress('Lade aus deinem Konto …', null);
    b.blob = await blobFetcher(b.blobHash);
    await putBank(b, false);
  }
  if (b.type === 'sfz' && b.files?.some((f) => !f.blob && f.hash)) {
    if (!blobFetcher) throw new Error('Diese Bibliothek liegt in deinem Konto – bitte anmelden.');
    const missing = b.files.filter((f) => !f.blob && f.hash);
    let i = 0;
    for (const f of missing) { onProgress('Lade Samples aus deinem Konto …', i++ / missing.length); f.blob = await blobFetcher(f.hash); }
    await putBank(b, false);
  }
}

/** All banks for the picker (without loading big blobs into memory more than needed). */
export async function listBanks() {
  const stored = (await tx('readonly', (s) => s.getAll())) || [];
  const imported = stored.filter((b) => !b.cacheOf && !b.deleted && b.type !== 'sysex').map(({ blob, files, voices, ...meta }) => meta);
  return [PIANO_BANK, GM_BANK, FM_BANK, ...imported.sort((a, b) => b.created - a.created)];
}

export const CUSTOM_ID = 'dx7-custom';

/** Read voices from .syx files (or ZIPs containing them) without storing anything – for the preset picker. */
export async function readSyxVoices(fileList) {
  const out = [];
  for (const f of fileList) {
    let parts = [{ path: f.name, blob: f }];
    if (/\.zip$/i.test(f.name)) parts = (await unzip(f)).filter((e) => /\.syx$/i.test(e.path));
    for (const p of parts) {
      if (!/\.syx$/i.test(p.path)) continue;
      const { voices } = parseSyx(await p.blob.arrayBuffer());
      const src = stripExt(base(p.path));
      voices.forEach((v, i) => out.push({ voice: v, source: src, index: i + 1 }));
    }
  }
  return out;
}

/** The user's own preset collection ("Meine FM-Presets"). */
export async function getCustom() {
  const c = await getBank(CUSTOM_ID);
  return (c && !c.deleted && c) || { id: CUSTOM_ID, name: 'Meine FM-Presets', type: 'dx7', format: 'SYX · eigene', created: Date.now(), voices: [] };
}
export async function saveCustom(voices) {
  const b = await getCustom();
  b.voices = voices;
  b.format = `SYX · eigene ×${voices.length}`;
  b.size = voices.length * 128;
  if (voices.length) await putBank(b);
  else await deleteBank(CUSTOM_ID);
  return b;
}
export async function addToCustom(voices) {
  const b = await getCustom();
  return saveCustom([...b.voices, ...voices]);
}
export async function saveVoicesAsBank(name, voices) {
  const bank = { id: 'dx7-' + uid(), name, type: 'dx7', format: `SYX · DX7 ×${voices.length}`, size: voices.length * 128, created: Date.now(), voices };
  await putBank(bank);
  return bank;
}

/** Imported SysEx files that contain commands (not voices) – can be sent to the piano or the synth. */
export async function listSysex() {
  const stored = (await tx('readonly', (s) => s.getAll())) || [];
  return stored.filter((b) => b.type === 'sysex' && !b.deleted).sort((a, b) => b.created - a.created);
}

/** Get the data needed to play a bank: {type:'sf', buffer} or {type:'sfz', files:Map, sfzPath}. */
export async function loadBankData(id, onProgress = () => {}) {
  if (id === GM_BANK.id) {
    const cached = await getBank('cache:' + id);
    if (cached?.blob) return { type: 'sf', buffer: await cached.blob.arrayBuffer() };
    const buffer = await download(GM_BANK.url, GM_BANK.size, onProgress);
    await putBank({ id: 'cache:' + id, cacheOf: id, blob: new Blob([buffer]) }); // keep offline copy
    return { type: 'sf', buffer };
  }
  if (id === FM_BANK.id) return { type: 'dx7', voices: KEYFLOW_FM, name: 'Keyflow FM' };
  const b = await getBank(id);
  if (!b || b.deleted) throw new Error('Sound bank not found');
  await ensureBlobs(b, onProgress);
  if (b.type === 'dx7') return { type: 'dx7', voices: b.voices, name: b.name };
  if (b.type === 'sf') return { type: 'sf', buffer: await b.blob.arrayBuffer() };
  return { type: 'sfz', files: new Map(b.files.map((f) => [f.path.toLowerCase(), f.blob])), sfzPath: b.sfzPath.toLowerCase() };
}

async function download(url, total, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Download failed: ' + r.status);
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  return await new Blob(chunks).arrayBuffer();
}

// ---------- import ----------
const base = (p) => p.split('/').pop();
const stripExt = (n) => n.replace(/\.[^.]+$/, '');

async function unzip(file) {
  const { unzipSync } = await import('https://esm.sh/fflate@0.8.2?target=es2022');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  return Object.entries(entries)
    .filter(([p, data]) => !p.endsWith('/') && !p.startsWith('__MACOSX') && data.length)
    .map(([p, data]) => ({ path: p.replace(/\\/g, '/'), blob: new Blob([data]) }));
}

/**
 * Import any mix of files (SoundFonts, SFZ + samples, ZIPs, folders).
 * @returns {Promise<{added: object[], skipped: string[]}>}
 */
export async function importFiles(fileList, onStatus = () => {}) {
  let entries = [];
  const skipped = [];
  for (const f of fileList) {
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (/\.zip$/i.test(f.name)) {
      onStatus('Entpacke ' + f.name + ' …');
      entries.push(...(await unzip(f)).map((e) => ({ ...e, zip: stripExt(f.name) })));
    } else entries.push({ path, blob: f });
  }
  const added = [];
  // 1) single-file SoundFonts
  for (const e of entries.filter((x) => SF_EXT.test(x.path))) {
    onStatus('Speichere ' + base(e.path) + ' …');
    const bank = { id: 'sf-' + uid(), name: stripExt(base(e.path)), type: 'sf', format: e.path.split('.').pop().toUpperCase(), size: e.blob.size, created: Date.now(), blob: e.blob };
    await putBank(bank);
    added.push(bank);
  }
  // 1b) SysEx (.syx): DX7 voice banks become playable FM banks, other messages are kept as sendable commands
  for (const e of entries.filter((x) => /\.syx$/i.test(x.path))) {
    onStatus('Lese ' + base(e.path) + ' …');
    const { voices, other } = parseSyx(await e.blob.arrayBuffer());
    if (voices.length) {
      const bank = { id: 'dx7-' + uid(), name: stripExt(base(e.path)), type: 'dx7', format: `SYX · DX7 ×${voices.length}`, size: e.blob.size, created: Date.now(), voices };
      await putBank(bank);
      added.push(bank);
    }
    if (other.length) {
      const sx = { id: 'syx-' + uid(), name: stripExt(base(e.path)), type: 'sysex', format: 'SYX', size: e.blob.size, created: Date.now(),
        messages: other.map((m) => [...m]), info: other.slice(0, 6).map(describeSysex), count: other.length };
      await putBank(sx);
      added.push(sx);
    }
    if (!voices.length && !other.length) skipped.push(base(e.path) + ' (keine SysEx-Daten gefunden)');
  }
  // 2) SFZ instruments: each .sfz becomes a bank sharing all non-SoundFont files it may reference
  const sfzs = entries.filter((x) => /\.sfz$/i.test(x.path));
  const support = entries.filter((x) => SAMPLE_EXT.test(x.path) || /\.(sfz|txt|sfzh)$/i.test(x.path));
  for (const s of sfzs) {
    onStatus('Speichere ' + base(s.path) + ' …');
    const text = await s.blob.text();
    // keep only the samples this SFZ (roughly) references to save storage: match by file name
    const names = new Set([...text.matchAll(/sample\s*=\s*([^\n\r]+?\.(?:wav|flac|ogg|oga|mp3|aif|aiff|m4a|opus))/gi)].map((m) => base(m[1].replace(/\\/g, '/')).toLowerCase()));
    const files = support.filter((x) => x === s || /\.(sfz|sfzh|txt)$/i.test(x.path) || names.size === 0 || names.has(base(x.path).toLowerCase()));
    const size = files.reduce((a, x) => a + x.blob.size, 0);
    const bank = { id: 'sfz-' + uid(), name: stripExt(base(s.path)), type: 'sfz', format: 'SFZ', size, created: Date.now(), sfzPath: s.path, files: files.map(({ path, blob }) => ({ path, blob })) };
    await putBank(bank);
    added.push(bank);
  }
  for (const e of entries) {
    if (UNSUPPORTED.test(e.path)) skipped.push(base(e.path) + ' (proprietäres Format)');
  }
  if (!added.length && !skipped.length) {
    if (entries.some((x) => SAMPLE_EXT.test(x.path))) skipped.push('Nur Samples gefunden – bitte die .sfz-Datei mit auswählen (oder den ganzen Ordner / eine ZIP)');
    else skipped.push('Keine SoundFont-Datei erkannt');
  }
  return { added: added.map(({ blob, files, voices, messages, ...m }) => m), skipped };
}
