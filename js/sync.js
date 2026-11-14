// Account sync: everything goes into the account.
//  • songs (incl. original audio as content-addressed blob)
//  • sound libraries: SoundFonts, SFZ (+ samples), DX7/reface banks, "Meine FM-Presets", SysEx commands
//  • profile: settings + coach chat
// Last-writer-wins per record (updatedAt); deletions are tombstones. Large files are uploaded once
// (SHA-256 addressed) and downloaded on demand on other devices.
// Two interchangeable backends: the local Keyflow server (server.js) or Supabase (public web version).
import * as db from './db.js';
import * as soundlib from './soundlib.js';
import { cloudBackend, cloudEnabled } from './cloud-backend.js';

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

// ---------------- backend: local Keyflow server ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...auth(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && account && !path.includes('login')) { logoutLocal(); throw new Error('Sitzung abgelaufen – bitte neu anmelden'); }
  if (!res.ok && res.status !== 409) throw new Error(data.error || `Server error ${res.status}`);
  return { status: res.status, data };
}
const serverBackend = {
  kind: 'server',
  async login(username, password, register) {
    const { data } = await api(register ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    return { username: data.username, token: data.token };
  },
  async logout() { try { await api('/api/logout', { method: 'POST' }); } catch {} },
  async session() { return account; },
  async list(kind) {
    if (kind === 'song') return (await api('/api/songs')).data.songs;
    if (kind === 'bank') return (await api('/api/banks')).data.banks;
    const p = (await api('/api/profile')).data;
    return p.updatedAt ? [{ ...p, id: 'me' }] : [];
  },
  async put(kind, rec) {
    const path = kind === 'song' ? '/api/songs/' + encodeURIComponent(rec.id) : kind === 'bank' ? '/api/banks/' + encodeURIComponent(rec.id) : '/api/profile';
    await api(path, { method: 'PUT', body: JSON.stringify(rec) });
    return { ok: true };
  },
  async hasBlob(hash) { return (await fetch('/api/blobs/' + hash, { method: 'HEAD', headers: auth() })).ok; },
  async putBlob(blob, hash) {
    const r = await fetch('/api/blobs' + (hash ? '/' + hash : ''), { method: 'PUT', headers: auth(), body: blob });
    if (!r.ok) throw new Error('Upload fehlgeschlagen: ' + ((await r.text()) || r.status));
    return (await r.json()).hash;
  },
  async getBlob(hash) {
    const r = await fetch('/api/blobs/' + hash, { headers: auth() });
    if (!r.ok) throw new Error('Datei nicht im Konto gefunden');
    return r.blob();
  },
  async usage() { return (await api('/api/usage')).data; },
};

/** The public static site uses Supabase (if configured); the local app uses its own server. */
const backend = window.KEYFLOW_STATIC && cloudEnabled() ? cloudBackend : serverBackend;
export const backendKind = () => (window.KEYFLOW_STATIC ? (cloudEnabled() ? 'cloud' : 'none') : 'server');

export async function login(username, password, register = false) {
  account = { ...(await backend.login(username.trim(), password, register)), kind: backend.kind };
  localStorage.setItem(KEY, JSON.stringify(account));
  await syncNow();
  return account;
}
function logoutLocal() { account = null; localStorage.removeItem(KEY); emit({ state: 'logged-out' }); }
export async function logout() { await backend.logout(); logoutLocal(); }

// ---------- blobs ----------
async function sha256(blob) {
  if (!globalThis.crypto?.subtle) return null; // not a secure context → the local server computes it
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function ensureBlob(blob, knownHash) {
  const h = knownHash || (await sha256(blob));
  if (h && (await backend.hasBlob(h))) return h;
  return backend.putBlob(blob, h);
}
export async function fetchBlob(hash) {
  if (!account) throw new Error('Nicht angemeldet – diese Datei liegt in deinem Konto');
  return backend.getBlob(hash);
}
soundlib.setBlobFetcher(fetchBlob);

// ---------- songs ----------
async function syncSongs(stats) {
  const remote = new Map((await backend.list('song')).map((s) => [s.id, s]));
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
        try { l.audioHash = await ensureBlob(l.audio, l.audioHash); }
        catch (e) { emit({ state: 'syncing', detail: `Audio „${l.title}“ übersprungen: ${e.message}` }); }
      }
      await db.put(l, false);
      const { audio, ...rest } = l;
      await backend.put('song', rest);
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
  const remote = new Map((await backend.list('bank')).map((b) => [b.id, b]));
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
      try {
        const rec = await bankForServer(l);
        await soundlib.putSyncedBank(l); // remember hashes locally
        await backend.put('bank', rec);
        stats.pushed++;
      } catch (e) {
        emit({ state: 'syncing', detail: `„${l.name}“ übersprungen: ${e.message}` });
      }
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
  const remote = (await backend.list('profile'))[0] || {};
  const localTs = +(localStorage.getItem(PROFILE_TS) || 0);
  if ((remote.updatedAt || 0) > localTs) {
    profileIO.apply(remote);
    localStorage.setItem(PROFILE_TS, String(remote.updatedAt));
    stats.pulled++;
  } else if (localTs > (remote.updatedAt || 0) || !remote.updatedAt) {
    const ts = localTs || Date.now();
    localStorage.setItem(PROFILE_TS, String(ts));
    await backend.put('profile', { id: 'me', ...profileIO.get(), updatedAt: ts });
    stats.pushed++;
  }
}

export async function syncNow() {
  if (!account || backendKind() === 'none') return;
  if (running) { again = true; return running; }
  running = (async () => {
    emit({ state: 'syncing' });
    const stats = { pulled: 0, pushed: 0 };
    try {
      if (backend.kind === 'cloud' && !(await backend.session())) { logoutLocal(); throw new Error('Bitte erneut anmelden'); }
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
export async function usage() { return backend.usage(); }
export const backupUrl = () => (account && backend.kind === 'server' ? '/api/backup?t=' + encodeURIComponent(account.token) : null);
export async function setAutoBackup(enabled) { return (await api('/api/autobackup', { method: 'PUT', body: JSON.stringify({ enabled }) })).data; }
export async function restoreBackup(file) {
  const r = await fetch('/api/restore', { method: 'POST', headers: auth(), body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Wiederherstellung fehlgeschlagen');
  await syncNow();
  return data;
}
