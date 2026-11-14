const DB_NAME = 'keyflow';
const STORE = 'songs';
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}

export const get = (id) => tx('readonly', (s) => s.get(id));
/** Save a song. `touch` marks it as changed (for sync); pass false when storing a synced copy. */
export const put = (song, touch = true) => {
  if (touch) song.updatedAt = Date.now();
  const r = tx('readwrite', (s) => s.put(song));
  if (touch) r.then(() => onChange?.(song));
  return r;
};
/** Deletion keeps a tombstone so other devices learn about it. */
export const del = async (id) => {
  const song = await get(id);
  if (!song) return;
  await put({ id, deleted: true, title: song.title, createdAt: song.createdAt });
};
export const getAll = () => tx('readonly', (s) => s.getAll()).then((a) => a.filter((x) => !x.deleted));
export const getAllRaw = () => tx('readonly', (s) => s.getAll());
let onChange = null;
export const setOnChange = (fn) => (onChange = fn);
