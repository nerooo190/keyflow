// Account sync with the Keyflow server: everything goes into the account.
//  • songs (incl. original audio as content-addressed blob)
//  • sound libraries: SoundFonts, SFZ (+ samples), DX7/reface banks, "Meine FM-Presets", SysEx commands
//  • profile: settings + coach chat
// Last-writer-wins per record (updatedAt); deletions are tombstones. Large files are uploaded once
// (SHA-256 addressed) and downloaded on demand on other devices.
import * as db from './db.js';
import * as soundlib from './soundlib.js';

const KEY = 'kf-account';
const PROFILE_TS = 'kf-profile-ts';
let account = JSON.parse(localStorage.getItem(KEY) || 'null'); // {username, token}
let pushTimer = null, running = null, again = false;
const listeners = new Set();
let profileIO = null; // {get(): {settings, chat}, apply(profile)}

export const getAccount = () => account;
export const onSyncState = (fn) => listeners.add(fn);
const emit = (state) => listeners.forEach((fn) => fn(state));
const auth = () => (account ? { authorization: 'Bearer ' + account.token } : {});

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...auth(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && account && !path.includes('login')) { logoutLocal(); throw new Error('Sitzung abgelaufen – bitte neu anmelden'); }
  if (!res.ok && res.status !== 409) throw new Error(data.error || `Server error ${res.status}`);
  return { status: res.status, data };
}

export async function login(username, password, register = false) {
  const { data } = await api(register ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  account = { username: data.username, token: data.token };
  localStorage.setItem(KEY, JSON.stringify(account));
  await syncNow();
  return account;
}
function logoutLocal() { account = null; localStorage.removeItem(KEY); emit({ state: 'logged-out' }); }
export async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch {} logoutLocal(); }

// ---------- blobs ----------
async function sha256(blob) {
  if (!globalThis.crypto?.subtle) return null; // not a secure context (e.g. LAN IP) → server computes it
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Make sure the server has this blob; returns its hash. */
async function ensureBlob(blob, knownHash) {
  const h = knownHash || (await sha256(blob));
  if (h) {
    const head = await fetch('/api/blobs/' + h, { method: 'HEAD', headers: auth() });
    if (head.ok) return h;
  }
  const r = await fetch('/api/blobs' + (h ? '/' + h : ''), { method: 'PUT', headers: auth(), body: blob });
  if (!r.ok) throw new Error('Upload fehlgeschlagen: ' + ((await r.text()) || r.status));
  return (await r.json()).hash;
}
export async function fetchBlob(hash) {
  if (!account) throw new Error('Nicht angemeldet – Datei liegt im Konto');
  const r = await fetch('/api/blobs/' + hash, { headers: auth() });
  if (!r.ok) throw new Error('Datei nicht im Konto gefunden');
  return r.blob();
}
soundlib.setBlobFetcher(fetchBlob);

// ---------- songs ----------
async function syncSongs(stats) {
  const { data } = await api('/api/songs');
  const remote = new Map(data.songs.map((s) => [s.id, s]));
  const local = new Map((await db.getAllRaw()).map((s) => [s.id, s]));
  for (const [id, r] of remote) {
    const l = local.get(id);
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) {
      const keepAudio = l?.audio && !r.deleted && (!r.audioHash || r.audioHash === l.audioHash);
      await db.put(keepAudio ? { ...r, audio: l.audio } : r, false);
      stats.pulled++;
    }
  }
  for (const [id, l] of local) {
    const r = remote.get(id);
    const needsAudio = l.audio && !l.deleted && (!l.audioHash || !r?.audioHash);
    if (!r || (l.updatedAt || 0) > (r.updatedAt || 0) || needsAudio) {
      if (!l.updatedAt) l.updatedAt = l.createdAt || Date.now();
      if (l.audio && !l.deleted) {
        emit({ state: 'syncing', detail: `Audio „${l.title}“` });
        l.audioHash = await ensureBlob(l.audio, l.audioHash);
      }
      await db.put(l, false);
      const { audio, ...rest } = l;
      await api('/api/songs/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(rest) });
      stats.pushed++;
    }
  }
}

// ---------- sound libraries ----------
async function bankForServer(b) {
  const { blob, files, ...rest } = b;
  if (b.deleted) return rest;
  if (b.type === 'sf' && blob) {
    emit({ state: 'syncing', detail: `SoundFont „${b.name}“` });
    rest.blobHash = b.blobHash = await ensureBlob(blob, b.blobHash);
  }
  if (b.type === 'sfz' && files) {
    let i = 0;
    for (const f of files) {
      emit({ state: 'syncing', detail: `SFZ „${b.name}“ ${++i}/${files.length}` });
      if (f.blob) f.hash = await ensureBlob(f.blob, f.hash);
    }
    rest.files = files.map(({ path, hash }) => ({ path, hash }));
  }
  return rest;
}

async function syncBanks(stats) {
  const { data } = await api('/api/banks');
  const remote = new Map(data.banks.map((b) => [b.id, b]));
  const local = new Map((await soundlib.allBankRecords()).map((b) => [b.id, b]));
  for (const [id, r] of remote) {
    const l = local.get(id);
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) {
      const keep = { ...r };
      if (!r.deleted && r.type === 'sf' && l?.blob && l.blobHash === r.blobHash) keep.blob = l.blob;
      if (!r.deleted && r.type === 'sfz') {
        const byHash = new Map((l?.files || []).filter((f) => f.blob && f.hash).map((f) => [f.hash, f.blob]));
        keep.files = (r.files || []).map((f) => ({ ...f, blob: byHash.get(f.hash) }));
      }
      await soundlib.putSyncedBank(keep);
      stats.pulled++;
    }
  }
  for (const [id, l] of local) {
    const r = remote.get(id);
    const missingBlobs = !l.deleted && ((l.type === 'sf' && l.blob && !l.blobHash) || (l.type === 'sfz' && (l.files || []).some((f) => f.blob && !f.hash)));
    if (!r || (l.updatedAt || 0) > (r.updatedAt || 0) || missingBlobs) {
      if (!l.updatedAt) l.updatedAt = l.created || Date.now();
      const rec = await bankForServer(l);
      await soundlib.putSyncedBank(l); // remember hashes locally
      await api('/api/banks/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(rec) });
      stats.pushed++;
    }
  }
}

// ---------- profile (settings + chat) ----------
export function registerProfile(io) { profileIO = io; }
export function profileChanged() {
  localStorage.setItem(PROFILE_TS, String(Date.now()));
  schedule();
}
async function syncProfile(stats) {
  if (!profileIO) return;
  const { data: remote } = await api('/api/profile');
  const localTs = +(localStorage.getItem(PROFILE_TS) || 0);
  if ((remote.updatedAt || 0) > localTs) {
    profileIO.apply(remote);
    localStorage.setItem(PROFILE_TS, String(remote.updatedAt));
    stats.pulled++;
  } else if (localTs > (remote.updatedAt || 0) || !remote.updatedAt) {
    const ts = localTs || Date.now();
    localStorage.setItem(PROFILE_TS, String(ts));
    await api('/api/profile', { method: 'PUT', body: JSON.stringify({ ...profileIO.get(), updatedAt: ts }) });
    stats.pushed++;
  }
}

export async function syncNow() {
  if (!account) return;
  if (running) { again = true; return running; }
  running = (async () => {
    emit({ state: 'syncing' });
    const stats = { pulled: 0, pushed: 0 };
    try {
      await syncSongs(stats);
      await syncBanks(stats);
      await syncProfile(stats);
      emit({ state: 'synced', ...stats, at: Date.now() });
      return stats;
    } catch (e) {
      emit({ state: 'error', message: e.message.includes('fetch') ? 'Server nicht erreichbar' : e.message });
    } finally {
      running = null;
      if (again) { again = false; schedule(); }
    }
  })();
  return running;
}

function schedule() {
  if (!account) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, 1500);
}
db.setOnChange(schedule);
soundlib.setOnBankChange(schedule);
window.addEventListener('online', () => syncNow());

// ---------- account tools ----------
export async function usage() { return (await api('/api/usage')).data; }
export const backupUrl = () => (account ? '/api/backup?t=' + encodeURIComponent(account.token) : null);
export async function setAutoBackup(enabled) { return (await api('/api/autobackup', { method: 'PUT', body: JSON.stringify({ enabled }) })).data; }
export async function restoreBackup(file) {
  const r = await fetch('/api/restore', { method: 'POST', headers: auth(), body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Wiederherstellung fehlgeschlagen');
  await syncNow();
  return data;
}
