// Supabase backend for accounts & sync on the public web version.
// Data: table keyflow_records (RLS: each user only sees their own rows).
// Large files (audio, SoundFonts, samples): private storage bucket "keyflow-blobs", path <user id>/<sha256>.
// Setup SQL: tools/supabase-setup.sql · Config: js/cloud-config.js
import { CLOUD } from './cloud-config.js';

let client = null;
async function sb() {
  if (!client) {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2?target=es2022');
    client = createClient(CLOUD.url, CLOUD.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return client;
}
const BUCKET = 'keyflow-blobs';
const err = (e) => { if (e) throw new Error(e.message || String(e)); };
async function uid() {
  const { data } = await (await sb()).auth.getUser();
  if (!data?.user) throw Object.assign(new Error('Nicht angemeldet'), { status: 401 });
  return data.user.id;
}

export const cloudEnabled = () => !!(CLOUD?.url && CLOUD?.anonKey);

export const cloudBackend = {
  kind: 'cloud',
  async login(email, password, register) {
    const c = await sb();
    // the confirmation e-mail links back to this page
    const r = register ? await c.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }) : await c.auth.signInWithPassword({ email, password });
    err(r.error);
    if (!r.data.session) throw new Error('Fast geschafft! Wir haben dir eine E-Mail geschickt – bestätige den Link darin und melde dich dann hier an.');
    return { username: r.data.user.email, token: 'supabase' };
  },
  async logout() { await (await sb()).auth.signOut(); },
  async session() {
    const { data } = await (await sb()).auth.getSession();
    return data.session ? { username: data.session.user.email, token: 'supabase' } : null;
  },

  async list(kind) {
    const c = await sb();
    const { data, error } = await c.from('keyflow_records').select('data').eq('kind', kind);
    err(error);
    return data.map((r) => r.data);
  },
  async put(kind, rec) {
    const c = await sb();
    const user_id = await uid();
    // last-writer-wins: never overwrite a newer copy
    const { data: cur } = await c.from('keyflow_records').select('updated_at').eq('kind', kind).eq('id', rec.id).maybeSingle();
    if (cur && cur.updated_at > (rec.updatedAt || 0)) return { conflict: true };
    const { error } = await c.from('keyflow_records').upsert({ user_id, kind, id: rec.id, data: rec, updated_at: rec.updatedAt || Date.now() });
    err(error);
    return { ok: true };
  },

  async hasBlob(hash) {
    const c = await sb();
    const { data } = await c.storage.from(BUCKET).list(await uid(), { search: hash, limit: 1 });
    return !!data?.some((f) => f.name === hash);
  },
  async putBlob(blob, hash) {
    if (!hash) throw new Error('Für den Upload wird eine sichere Verbindung (https) benötigt.');
    const c = await sb();
    const { error } = await c.storage.from(BUCKET).upload(`${await uid()}/${hash}`, blob, { upsert: false, contentType: 'application/octet-stream' });
    if (error && !/exists|duplicate/i.test(error.message)) {
      throw new Error(/size|large|payload/i.test(error.message) ? 'Datei zu groß für den Cloud-Speicher (max. 50 MB pro Datei im Gratis-Tarif)' : error.message);
    }
    return hash;
  },
  async getBlob(hash) {
    const c = await sb();
    const { data, error } = await c.storage.from(BUCKET).download(`${await uid()}/${hash}`);
    err(error);
    return data;
  },
  async usage() {
    const c = await sb();
    const { data: files } = await c.storage.from(BUCKET).list(await uid(), { limit: 1000 });
    const songs = (await this.list('song')).filter((s) => !s.deleted).length;
    const banks = (await this.list('bank')).filter((b) => !b.deleted).length;
    const blobBytes = (files || []).reduce((a, f) => a + (f.metadata?.size || 0), 0);
    return { songs, banks, blobBytes, totalBytes: blobBytes, free: null, cloud: true };
  },
};
