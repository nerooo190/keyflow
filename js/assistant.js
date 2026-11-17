// Keyflow Coach – AI chat backed by a local LLM (Ollama on the Keyflow server). Free, unlimited, private.
import { esc, ic } from './util.js';

const KEY = 'kf-chat';
export let history = JSON.parse(localStorage.getItem(KEY) || '[]'); // [{role, content}]
const save = () => { localStorage.setItem(KEY, JSON.stringify(history.slice(-40))); document.dispatchEvent(new Event('kf-profile')); };
/** Replace the chat (used when the account sync brings a newer chat). */
export function setHistory(h) { history = Array.isArray(h) ? h.slice(-40) : []; localStorage.setItem(KEY, JSON.stringify(history)); }

/** Remove a trailing unanswered question and return its text (for "retry"). */
export function popUnanswered() {
  const last = history[history.length - 1];
  if (!last || last.role !== 'user') return null;
  history.pop(); save();
  return last.content;
}

export function clearChat() { history = []; save(); }

export async function status() {
  try {
    const r = await fetch('/api/ai/status');
    return r.ok ? r.json() : { installed: false, running: false };
  } catch { return { offline: true }; }
}

export async function pull(model) {
  const r = await fetch('/api/ai/pull?model=' + encodeURIComponent(model), { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
}

/** Send a user message; calls onDelta(fullTextSoFar) while the answer streams in. */
export async function ask(text, context, onDelta) {
  history.push({ role: 'user', content: text });
  save();
  const r = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: history, context }),
  });
  if (!r.ok) {
    history.pop(); save();
    const err = (await r.json().catch(() => ({}))).error || 'AI error ' + r.status;
    throw Object.assign(new Error(err), { code: err });
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += dec.decode(value, { stream: true });
    onDelta(full);
  }
  history.push({ role: 'assistant', content: full.trim() });
  save();
  return full;
}

/** Turn an answer into safe HTML; [[song: Title - Artist]] tags become "learn" cards. */
export function render(text, streaming = false) {
  const songs = [];
  let t = text.replace(/\[\[\s*song\s*:\s*([^\]\n]{2,120})\]\]/gi, (_, s) => { songs.push(s.trim()); return `\u0000${songs.length - 1}\u0000`; });
  if (streaming) t = t.replace(/\[\[[^\]]*$/, ''); // hide half-written tag
  let html = esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const s = songs[+i];
    return `<button class="song-card" data-learn="${esc(s)}"><span class="sc-icon">${ic('ic-keyboard')}</span><span class="sc-title">${esc(s)}</span><span class="sc-go">Learn ›</span></button>`;
  });
  return html.replace(/(<br>)*(<button class="song-card")/g, '$2').replace(/(<\/button>)(<br>)+/g, '$1');
}

// ---------------- in-browser coach (public web version): llama.cpp via wllama (MIT), no server ----------------
const WLLAMA = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.13.0/esm/index.js';
const WLLAMA_WASM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.13.0/esm/wasm-from-cdn.js';
export const BROWSER_MODELS = [
  { id: 'qwen-0.5b', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', size: '≈490 MB', note: 'schnell, läuft auf fast jedem Handy' },
  { id: 'qwen-1.5b', repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', size: '≈1,1 GB', note: 'klüger, braucht mehr RAM' },
];
const BM_KEY = 'kf-browser-model';
let wllama = null, loadedId = null, loading = null;

export const browserModel = () => BROWSER_MODELS.find((m) => m.id === localStorage.getItem(BM_KEY)) || null;
export const browserLoaded = () => !!loadedId;

/** Download (first time) or load from the browser cache, then keep it in memory. */
export async function loadBrowserModel(id, onProgress = () => {}) {
  const m = BROWSER_MODELS.find((x) => x.id === id);
  if (!m) throw new Error('Unbekanntes Modell');
  if (loadedId === id) return;
  if (loading) return loading;
  loading = (async () => {
    const [{ Wllama }, { default: wasm }] = await Promise.all([import(WLLAMA), import(WLLAMA_WASM)]);
    if (wllama) { try { await wllama.exit(); } catch {} }
    wllama = new Wllama(wasm);
    await wllama.loadModelFromHF({ repo: m.repo, file: m.file }, {
      n_ctx: 2048,
      useCache: true,
      progressCallback: ({ loaded, total }) => onProgress(total ? loaded / total : 0),
    });
    loadedId = id;
    localStorage.setItem(BM_KEY, id);
  })();
  try { await loading; } finally { loading = null; }
}

export function forgetBrowserModel() { localStorage.removeItem(BM_KEY); }

/** Same contract as ask(): streams the answer of the in-browser model. */
export async function askBrowser(text, context, onDelta, systemPrompt) {
  if (!loadedId) throw new Error('Der KI-Coach ist noch nicht geladen.');
  history.push({ role: 'user', content: text });
  save();
  const messages = [{ role: 'system', content: systemPrompt(context || {}) }, ...history.slice(-12)];
  let full = '';
  try {
    const stream = await wllama.createChatCompletion({ messages, stream: true, temperature: 0.7, max_tokens: 400 });
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta?.content;
      if (d) { full += d; onDelta(full); }
    }
  } catch (e) {
    history.pop(); save();
    throw e;
  }
  history.push({ role: 'assistant', content: full.trim() });
  save();
  return full;
}
