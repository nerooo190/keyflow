// Keyflow Coach – AI chat backed by a local LLM (Ollama on the Keyflow server). Free, unlimited, private.
import { esc, ic } from './util.js';

const KEY = 'kf-chat';
export let history = JSON.parse(localStorage.getItem(KEY) || '[]'); // [{role, content}]
const save = () => { localStorage.setItem(KEY, JSON.stringify(history.slice(-40))); document.dispatchEvent(new Event('kf-profile')); };
/** Replace the chat (used when the account sync brings a newer chat). */
export function setHistory(h) { history = Array.isArray(h) ? h.slice(-40) : []; localStorage.setItem(KEY, JSON.stringify(history)); }

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
