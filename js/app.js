import * as db from './db.js';
import { CATALOG, GENRES, searchCatalog } from './songs.js';
import { coverStyle, relDay, esc, uid, fmtTime, ic } from './util.js';
import { Player } from './player.js';
import { piano } from './audio.js';
import { inputs } from './input.js';
import * as sync from './sync.js';
import { LIGHT_PROTOCOLS } from './lights.js';
import * as ai from './assistant.js';
import { SYSTEM_PROMPT } from './coach-prompt.js';
import * as soundlib from './soundlib.js';
import { GM_FAMILIES } from './sf-engine.js';
import { parseSyx } from './dx7.js';
import { LEVELS, rate, simplify } from './difficulty.js';
import { analyze, toMusicXML } from './score.js';

const $ = (s) => document.querySelector(s);
/** Public static build (GitHub Pages): no Keyflow server → server-only features are hidden. */
const STATIC = !!window.KEYFLOW_STATIC;
if (STATIC) document.documentElement.classList.add('static');
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------- settings ----------------
const DEFAULTS = { difficulty: 'original', handMode: 'both', otherHand: 'auto', fingerColors: true, handDiagram: true, editFingers: false, midiOut: { device: 'off', R: { on: true, ch: 0 }, L: { on: true, ch: 1 }, user: { on: false, ch: 2 }, program: -1, exclusive: false }, sound: { bank: 'piano', presets: {} }, fingers: true, autoTempo: true, passAcc: 90, labels: 'letters', keyboard: '88', colors: 'rainbow', keyLights: true, lightProto: 'vangoa', lightAhead: 'ahead', silentLights: true, zoom: 1, guideSound: true, muteSong: false, midiSound: true, metronome: false, effects: true, volume: 0.8, speed: 1, mode: 'play', sort: 'recent', micSens: 0.5 };
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kf-settings') || '{}'), micActive: false };
const saveSettings = (fromSync = false) => {
  const { micActive, ...s } = settings;
  localStorage.setItem('kf-settings', JSON.stringify(s));
  if (!fromSync) sync.profileChanged();
};
piano.volume = settings.volume;

// ---------------- helpers ----------------
/** Android/Chrome: a picked file becomes unreadable once its <input> is reset (or after a while).
 *  Copy the bytes into memory right away, then it is safe to reset the input. */
async function snapshotFiles(list) {
  return Promise.all([...list].map(async (f) => {
    const copy = new File([await f.arrayBuffer()], f.name, { type: f.type, lastModified: f.lastModified });
    if (f.webkitRelativePath) Object.defineProperty(copy, 'webkitRelativePath', { value: f.webkitRelativePath });
    return copy;
  }));
}

function toast(msg, ms = 2800, icon = null) {
  const t = $('#toast');
  t.innerHTML = (icon ? ic(icon) : '') + esc(msg);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function busy(stage, pct = null) {
  $('#busy').classList.remove('hidden');
  $('#busyStage').textContent = stage;
  $('#busyBar').style.width = pct == null ? '0%' : `${Math.round(pct * 100)}%`;
}
const unbusy = () => $('#busy').classList.add('hidden');

function sheet(title, actions) {
  const el = $('#sheet');
  el.innerHTML = `<div class="sheet-card"><h4>${esc(title)}</h4>${actions.map((a, i) => `<button data-i="${i}" class="${a.danger ? 'danger' : ''}">${a.icon ? ic(a.icon) : ''}${esc(a.label)}</button>`).join('')}<button data-i="-1">Cancel</button></div>`;
  el.classList.remove('hidden');
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b && e.target !== el) return;
    el.classList.add('hidden');
    const i = b ? +b.dataset.i : -1;
    if (i >= 0) actions[i].run();
  };
}

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
}

// ---------------- routing ----------------
async function route() {
  const h = location.hash || '#/library';
  if (currentPlayer && !h.startsWith('#/play/')) closePlayer();
  if (h.startsWith('#/play/')) return openPlayer(decodeURIComponent(h.slice(7)));
  if (h.startsWith('#/score/')) return openScore(decodeURIComponent(h.slice(8)));
  if (h === '#/new') { show('create'); renderCreate(); return; }
  show('library');
  renderLibrary();
}
window.addEventListener('hashchange', route);

// ---------------- library ----------------
async function seedIfEmpty() {
  if (localStorage.getItem('kf-seeded')) return false;
  localStorage.setItem('kf-seeded', '1');
  for (const id of ['builtin-fur-elise', 'builtin-ode-to-joy', 'builtin-jingle-bells']) await addBuiltin(id, false);
  return true;
}

async function addBuiltin(id, open = true) {
  const s = CATALOG.find((c) => c.id === id);
  const existing = await db.get(id);
  if (!existing || existing.deleted) {
    const { notes, duration } = s.build();
    await db.put({ id, title: s.title, notes, duration, bpm: s.bpm, source: 'builtin', createdAt: Date.now(), lastPlayed: null });
  }
  if (open) location.hash = '#/play/' + encodeURIComponent(id);
}

async function renderLibrary() {
  const q = $('#searchInput').value.toLowerCase().trim();
  let songs = await db.getAll();
  songs = songs.filter((s) => !q || s.title.toLowerCase().includes(q));
  const sort = settings.sort;
  songs.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'played' ? (b.lastPlayed || 0) - (a.lastPlayed || 0) : b.createdAt - a.createdAt);
  $('#emptyLib').classList.toggle('hidden', songs.length > 0);
  $('#songList').innerHTML = songs.map((s) => {
    const day = relDay(s.lastPlayed);
    const sub = day ? `<span class="tri">▶</span> Last played ${day}` : `<span class="tri off">▶</span> Not played yet`;
    const best = s.best != null ? ` · best ${s.best}%` : '';
    const rt = rate(s.notes, s.duration);
    const badge = `<span class="lvl lvl-${rt.label}">${rt.label} ${rt.score}/10</span>`;
    return `<li class="song" data-id="${esc(s.id)}">
      <span class="cover" style="${coverStyle(s.id)}"></span>
      <div class="song-info"><div class="song-title">${esc(s.title)}</div><div class="song-sub">${badge}${sub}${best}</div></div>
      <button class="more" data-more="${esc(s.id)}" aria-label="More">•••</button></li>`;
  }).join('');
  $$('#sortMenu button').forEach((b) => b.classList.toggle('active', b.dataset.sort === sort));
}

$('#searchInput').addEventListener('input', renderLibrary);
$('#sortBtn').onclick = (e) => { e.stopPropagation(); $('#sortMenu').classList.toggle('hidden'); };
$('#sortMenu').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.sort = b.dataset.sort; saveSettings();
  $('#sortMenu').classList.add('hidden');
  renderLibrary();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#sortMenu, #sortBtn')) $('#sortMenu').classList.add('hidden');
  if (!e.target.closest('#plusMenu, #plusBtn')) $('#plusMenu').classList.add('hidden');
});
$('#addBtn').onclick = () => (location.hash = '#/new');
$('#songList').onclick = async (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    e.stopPropagation();
    const song = await db.get(more.dataset.more);
    sheet(song.title, [
      { label: '▶  Play', run: () => (location.hash = '#/play/' + encodeURIComponent(song.id)) },
      { label: 'Rename', run: async () => { const t = prompt('Song title', song.title); if (t) { song.title = t.trim(); await db.put(song); renderLibrary(); } } },
      { icon: 'ic-practice', label: 'Genauigkeit messen (mit Referenz-MIDI/MusicXML)', run: () => measureAccuracy(song) },
      { icon: 'ic-chord', label: 'Noten anzeigen (Partitur, PDF, MusicXML)', run: () => (location.hash = '#/score/' + encodeURIComponent(song.id)) },
      { icon: 'ic-export', label: 'Export MIDI', run: async () => (await import('./midi.js')).exportMidi(song) },
      ...(song.audio || song.audioHash ? [{ icon: 'ic-note', label: 'Re-transcribe (other settings)', run: () => retranscribe(song) }] : []),
      { label: 'Delete', danger: true, run: async () => { if (confirm(`Delete “${song.title}”?`)) { await db.del(song.id); renderLibrary(); } } },
    ]);
    return;
  }
  const li = e.target.closest('.song');
  if (li) location.hash = '#/play/' + encodeURIComponent(li.dataset.id);
};

// ---------------- create / AI coach chat ----------------
let activeGenre = null, aiState = null, aiBusy = false, libSummary = [], pullTimer = null;
const QUICK = [['ic-note', 'Empfiehl mir Songs, die zu mir passen'], ['ic-sprout', 'Leichte Songs für Anfänger'], ['ic-calendar', 'Mach mir einen Übungsplan für diese Woche'], ['ic-chord', 'Erklär mir Akkorde ganz einfach']];

const aiContext = () => ({ catalog: CATALOG.map((c) => c.title), library: libSummary, genre: activeGenre });

async function renderCreate() {
  $('#genreChips').innerHTML = GENRES.map((g) => `<button class="chip ${g === activeGenre ? 'active' : ''}" data-genre="${g}">${g}</button>`).join('');
  renderChat();
  libSummary = (await db.getAll()).map((x) => `${x.title} · ${x.best != null ? x.best + '%' : 'no score'} · ${relDay(x.lastPlayed) || 'never played'}`);
  refreshAi();
}

let warmed = false;
async function refreshAi() {
  if (STATIC) { aiState = { static: true }; return renderAiBar(); }
  aiState = await ai.status();
  if (aiState.model && !warmed) { warmed = true; fetch('/api/ai/warm', { method: 'POST' }).catch(() => {}); }
  renderAiBar();
  if (aiState.pull?.active && !pullTimer) pullTimer = setInterval(async () => {
    aiState = await ai.status();
    renderAiBar();
    if (!aiState.pull?.active) { clearInterval(pullTimer); pullTimer = null; if (aiState.pull?.error) toast(aiState.pull.error, 5000); }
  }, 1000);
}

function renderAiBar() {
  const bar = $('#aiBar');
  const st = aiState || {};
  let html = '';
  if (STATIC) {
    const bm = ai.browserModel();
    if (ai.browserLoaded()) {
      html = `<div class="ai-ready"><span>${ic('ic-coach')} Coach bereit · <span class="muted">${esc(bm.id)} im Browser</span></span><span><button class="link small" id="newChat">Neuer Chat</button> <button class="link small" data-bswitch="1">Modell</button></span></div>`;
    } else if (bm) {
      html = `<div class="ai-ready"><span>${ic('ic-coach')} Coach: <span class="muted">${esc(bm.id)} – wird bei der ersten Frage aus dem Browser-Speicher geladen</span></span><button class="link small" data-bswitch="1">Modell</button></div>`;
    } else {
      html = `<div class="ai-setup">${ic('ic-coach')} <b>KI-Coach aktivieren</b> – läuft komplett in deinem Browser, kostenlos, nichts wird an einen Server geschickt. Einmaliger Download (WLAN empfohlen), danach im Browser gespeichert:
        ${ai.BROWSER_MODELS.map((m) => `<button class="btn small-btn" data-bpull="${m.id}">${esc(m.id)} · ${esc(m.size)} – ${esc(m.note)}</button>`).join('')}
        <div class="muted small" style="margin-top:6px">Song-Suche & Links gibt es nur in der lokalen App – hier lädst du Songs mit <b>+</b> hoch.</div></div>`;
    }
  } else if (st.offline) {
    html = `<div class="ai-setup"><b>Server offline:</b> Der Keyflow-Server läuft nicht. Starte ihn in Termux mit <code>~/keyflow.sh</code> und lade die Seite neu.</div>`;
  } else if (!st.installed) {
    html = `<div class="ai-setup">${ic('ic-coach')} Für den KI-Coach: in Termux <code>pkg install ollama</code> ausführen, dann Server neu starten. Songnamen werden bis dahin direkt gesucht.</div>`;
  } else if (st.pull?.active) {
    const pct = st.pull.total ? Math.round((st.pull.completed / st.pull.total) * 100) : 0;
    html = `<div class="ai-setup">⬇️ Lade KI-Modell <b>${esc(st.pull.model)}</b> … ${pct}% <span class="muted small">(${esc(st.pull.status)})</span><div class="bar"><div style="width:${pct}%"></div></div></div>`;
  } else if (!st.model) {
    html = `<div class="ai-setup">${ic('ic-coach')} <b>KI-Coach aktivieren</b> – läuft komplett auf deinem Handy, kostenlos & unbegrenzt. Einmalig ein Modell laden (WLAN empfohlen):
      ${st.free != null ? `<div class="muted small">Freier Speicher: ${(st.free / 1e9).toFixed(1)} GB</div>` : ''}
      ${(st.choices || []).map((c) => `<button class="btn small-btn" data-pull="${esc(c.id)}" ${c.fits ? '' : 'disabled'}>${esc(c.id)} · ${esc(c.size)} – ${esc(c.note)}${c.fits ? '' : ' (zu wenig Speicher)'}</button>`).join('')}</div>`;
  } else {
    html = `<div class="ai-ready"><span>${ic('ic-coach')} Coach bereit · <span class="muted">${esc(st.model)}</span></span><button class="link small" id="newChat">Neuer Chat</button></div>`;
  }
  bar.innerHTML = html;
}

function bubble(m) {
  return m.role === 'user'
    ? `<div class="bubble me">${esc(m.content)}</div>`
    : `<div class="bubble ai">${ai.render(m.content)}</div>`;
}

function renderChat() {
  const box = $('#createResults');
  let html = '';
  if (!ai.history.length) {
    html += `<div class="bubble ai">Hi! Ich bin dein <b>Keyflow Coach</b> ${ic('ic-coach')} Sag mir, was du lernen willst, frag nach Song-Empfehlungen, einem Übungsplan oder Musiktheorie. Oder tippe einfach einen Songnamen.</div>
      <div class="quick">${QUICK.map((q) => `<button class="chip" data-quick="${esc(q[1])}">${ic(q[0])}${esc(q[1])}</button>`).join('')}</div>`;
  }
  html += ai.history.map(bubble).join('');
  if (ai.history.length && ai.history[ai.history.length - 1].role === 'user' && !aiBusy) {
    html += `<div class="bubble ai"><span class="muted small">Keine Antwort erhalten.</span> <button class="link small" data-retry="1">Antwort holen ↻</button></div>`;
  }
  const hits = activeGenre ? searchCatalog('', activeGenre) : [];
  if (hits.length) {
    html += `<p class="muted small">Sofort spielbar (${esc(activeGenre)}):</p>` + hits.map((x) => `<div class="result" data-builtin="${x.id}"><span class="cover" style="${coverStyle(x.id)}"></span><div><div>${esc(x.title)}</div><div class="muted small">${x.genre} · ready to play</div></div></div>`).join('');
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

async function sendChat(text) {
  if (aiBusy) return;
  if (STATIC && !ai.browserModel()) {
    return toast('Aktiviere oben zuerst den KI-Coach (einmaliger Download).', 4000, 'ic-coach');
  }
  if (STATIC && !ai.browserLoaded()) {
    try {
      busy('Lade KI-Coach …', 0);
      await ai.loadBrowserModel(ai.browserModel().id, (p) => busy('Lade KI-Coach …', p));
      unbusy();
      renderAiBar();
    } catch (err) { unbusy(); return toast('KI-Coach konnte nicht geladen werden: ' + err.message, 6000); }
  }
  if (!STATIC && !aiState?.model) {
    // no AI available → behave like before: treat the text as a song name
    toast('KI-Coach noch nicht aktiv – suche den Song direkt', 2500);
    return handleSearch(text);
  }
  aiBusy = true;
  $('#askInput').value = '';
  const box = $('#createResults');
  renderChat();
  box.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(text)}</div><div class="bubble ai typing" id="liveBubble"><span class="dots"><i></i><i></i><i></i></span></div>`);
  box.scrollTop = box.scrollHeight;
  const live = $('#liveBubble');
  const slow = setTimeout(() => {
    if (live.classList.contains('typing')) live.insertAdjacentHTML('beforeend', '<div class="muted small">Coach lädt das Modell … beim ersten Mal kann das bis zu 1 Minute dauern.</div>');
  }, 4000);
  try {
    await (STATIC ? (t, c, f) => ai.askBrowser(t, c, f, SYSTEM_PROMPT) : ai.ask)(text, aiContext(), (full) => {
      live.classList.remove('typing');
      live.innerHTML = ai.render(full, true);
      box.scrollTop = box.scrollHeight;
    });
  } catch (err) {
    live.classList.remove('typing');
    live.innerHTML = err.code === 'no-model' ? 'Bitte zuerst oben ein KI-Modell laden.' : err.code === 'no-ollama' ? 'Ollama läuft nicht – Server neu starten.' : 'Fehler: ' + esc(err.message);
    refreshAi();
  } finally {
    clearTimeout(slow);
    aiBusy = false;
  }
  renderChat();
}

function learn(title) {
  const t = title.toLowerCase();
  const hit = CATALOG.find((c) => t.includes(c.title.toLowerCase().split(' (')[0]));
  if (hit) return addBuiltin(hit.id);
  if (STATIC) return toast(`„${title}“: lade die Audiodatei (oder ein Piano-Cover) mit + hoch – Keyflow macht daraus das Tutorial.`, 6000, 'ic-note');
  return handleSearch(title.replace(/\s+-\s+/, ' '));
}

$('#genreChips').onclick = (e) => {
  const c = e.target.closest('[data-genre]');
  if (!c) return;
  activeGenre = activeGenre === c.dataset.genre ? null : c.dataset.genre;
  $('#genreChips').querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.genre === activeGenre));
  renderChat();
  if (activeGenre && aiState?.model) sendChat(`Empfiehl mir ${activeGenre}-Songs, die ich auf dem Klavier lernen kann.`);
};
$('#createResults').onclick = (e) => {
  const b = e.target.closest('[data-builtin]');
  if (b) return addBuiltin(b.dataset.builtin);
  const l = e.target.closest('[data-learn]');
  if (l) return learn(l.dataset.learn);
  if (e.target.closest('[data-retry]')) { const t = ai.popUnanswered(); if (t) sendChat(t); return; }
  const q = e.target.closest('[data-quick]');
  if (q) return sendChat(q.dataset.quick);
};
$('#aiBar').addEventListener('click', async (e) => {
  const pull = e.target.closest('[data-bpull]')?.dataset.bpull;
  if (pull) {
    try {
      busy('Lade KI-Coach (einmalig) …', 0);
      await ai.loadBrowserModel(pull, (p) => busy('Lade KI-Coach (einmalig) …', p));
      unbusy();
      toast('KI-Coach bereit – frag mich etwas!', 3000, 'ic-coach');
    } catch (err) { unbusy(); toast('Download fehlgeschlagen: ' + err.message, 6000); }
    return renderAiBar();
  }
  if (e.target.closest('[data-bswitch]')) { ai.forgetBrowserModel(); renderAiBar(); }
});
$('#aiBar').onclick = async (e) => {
  const p = e.target.closest('[data-pull]');
  if (p) {
    try { await ai.pull(p.dataset.pull); toast('Download gestartet – du kannst solange weiter üben'); } catch (err) { toast(err.message, 4000); }
    return refreshAi();
  }
  if (e.target.id === 'newChat') { ai.clearChat(); renderChat(); }
};
$('#optMax').onclick = applyMaxAccuracy;
$('#createBack').onclick = () => (location.hash = '#/library');
$('#skipBtn').onclick = () => (location.hash = '#/library');
$('#plusBtn').onclick = (e) => { e.stopPropagation(); $('#plusMenu').classList.toggle('hidden'); };
$('#plusMenu').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#plusMenu').classList.add('hidden');
  if (b.dataset.act === 'record') return recordAndTranscribe();
  if (b.dataset.act === 'songscription') return openSongscription();
  $('#fileInput').accept = b.dataset.act === 'midi' ? '.mid,.midi,audio/midi,.musicxml,.xml,.mxl' : 'audio/*,video/*,.mp3,.wav,.m4a,.ogg,.flac,.webm,.mp4';
  $('#fileInput').click();
};
$('#recBtn').onclick = () => recordAndTranscribe();
$('#fileInput').onchange = async (e) => {
  let f;
  try { [f] = await snapshotFiles([...e.target.files].slice(0, 1)); }
  catch { return toast('Datei konnte nicht gelesen werden – bitte direkt aus dem Speicher (nicht aus „Zuletzt verwendet“) wählen.', 6000); }
  finally { e.target.value = ''; }
  if (f) handleFile(f);
};
$('#askForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#askInput').value.trim();
  if (!q) return;
  if (/^https?:\/\//i.test(q)) return handleLink(q);
  const hits = searchCatalog(q, null);
  if (hits.length && hits[0].title.toLowerCase().startsWith(q.toLowerCase())) return addBuiltin(hits[0].id);
  return sendChat(q);
};

async function handleSearch(q) {
  const kind = $('#optKind').value;
  busy(`Searching YouTube for “${q}”${kind === 'cover' ? ' (piano cover)' : ''}…`);
  try {
    const res = await fetch(`/api/search?kind=${kind}&q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error((await res.text()) || `Search failed (${res.status})`);
    const found = decodeURIComponent(res.headers.get('x-title') || '') || q;
    const buf = await res.arrayBuffer();
    $('#askInput').value = '';
    toast(`Found: ${found}`, 4000);
    await transcribeBuffer(buf, q.replace(/\b\w/g, (c) => c.toUpperCase()), 'search');
  } catch (err) {
    console.error(err);
    unbusy();
    toast(err.message.includes('Failed to fetch') ? 'Song search needs the local server (node server.js) with yt-dlp.' : err.message, 5000);
  }
}

// drag & drop anywhere
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

/** Preset: best possible accuracy (separation first, then the strongest available models together). */
function applyMaxAccuracy() {
  $('#optDemucs').checked = true;
  $('#optMode').value = 'full';
  const tk = $('#optModel option[value=transkun]');
  $('#optModel').value = tk && !tk.disabled ? 'transkun' : 'both';
  $('#optSens').value = 0.55;
  toast(`Höchste Genauigkeit: Demucs + ${$('#optModel').value === 'transkun' ? 'Transkun' : 'Basic Pitch & Onsets-and-Frames kombiniert'} · volle Detailtiefe. Dauert länger.`, 6000, 'ic-trophy');
}
const transcribeOpts = () => ({
  sens: +$('#optSens').value,
  split: +$('#optSplit').value,
  mode: $('#optMode').value,
  drums: $('#optDrums').checked,
  model: $('#optModel').value,
  demucs: $('#optDemucs').checked && !$('#optDemucs').disabled,
  msSize: $('#optMsSize').value,
  quantize: $('#optQuantize').checked,
});
let lastModel = $('#optModel').value;
$('#optModel').addEventListener('change', (e) => {
  // Songscription has no API: open it and switch back to the previous in-app model
  if (e.target.value === 'songscription') { e.target.value = lastModel; openSongscription(); return; }
  lastModel = e.target.value;
});
$('#optModel').addEventListener('change', () => {
  const ms = $('#optModel').value === 'muscriptor';
  $('#msRow').classList.toggle('hidden', !ms);
  $('#msQRow').classList.toggle('hidden', !ms);
});

async function handleFile(file) {
  const title = file.name.replace(/\.[^.]+$/, '');
  try {
    const buf = await file.arrayBuffer();
    if (/\.(musicxml|mxl|xml)$/i.test(file.name)) {
      busy('Lese MusicXML …');
      const { parseMusicXML } = await import('./musicxml.js');
      const r = await parseMusicXML(buf, file.name);
      return saveAndOpen({ title: r.title || title, notes: r.notes, duration: r.duration, bpm: r.bpm, source: 'musicxml' });
    }
    if (/\.midi?$/i.test(file.name) || file.type.includes('midi')) {
      busy('Reading MIDI…');
      const { parseMidi } = await import('./midi.js');
      const r = await parseMidi(buf);
      return saveAndOpen({ title: r.title || title, notes: r.notes, duration: r.duration, source: 'midi' });
    }
    await transcribeBuffer(buf, title, 'audio');
  } catch (err) {
    console.error(err);
    unbusy();
    toast(err.message || 'Something went wrong');
  }
}

/** Songscription.ai has no public API → open it in a new tab; its MIDI/MusicXML export comes back via import. */
function openSongscription() {
  window.open('https://www.songscription.ai/new', '_blank', 'noopener');
  sheet('Songscription → Keyflow', [
    { icon: 'ic-import', label: 'Fertig? Exportierte MIDI-/MusicXML-Datei importieren', run: () => {
      $('#fileInput').accept = '.mid,.midi,audio/midi,.musicxml,.xml,.mxl';
      $('#fileInput').click();
    } },
  ]);
  toast('Songscription ist geöffnet: Song transkribieren, als MIDI oder MusicXML herunterladen und hier importieren.', 7000, 'ic-chord');
}

const MODES = { piano: 'Piano arrangement', easy: 'Easy (melody + bass)', full: 'Full detail' };

async function transcribeBuffer(buf, title, source, opts = transcribeOpts()) {
  const { transcribe } = await import('./transcribe.js');
  const audio = new Blob([buf]); // keep the original so it can be re-transcribed later
  const r = await transcribe(buf, (stage, pct) => busy(stage, pct), opts);
  if (!r.notes.length) throw new Error('No notes detected – try a clearer recording or higher sensitivity.');
  await saveAndOpen({ title, notes: r.notes, duration: r.duration, source, audio, opts });
}

/** The song's original audio – from this device or, if it was made elsewhere, from the account. */
async function songAudio(song) {
  if (song.audio) return song.audio;
  if (!song.audioHash) throw new Error('Für diesen Song ist keine Audiodatei gespeichert.');
  busy('Lade Audio aus deinem Konto …');
  song.audio = await sync.fetchBlob(song.audioHash);
  await db.put(song, false);
  return song.audio;
}

function retranscribe(song) {
  const run = (mode, drums) => async () => {
    try {
      const { transcribe } = await import('./transcribe.js');
      const opts = { ...transcribeOpts(), mode, drums };
      const r = await transcribe(await (await songAudio(song)).arrayBuffer(), (st, pct) => busy(st, pct), opts);
      Object.assign(song, { notes: r.notes, duration: r.duration, opts, best: null });
      await db.put(song);
      unbusy();
      location.hash = '#/play/' + encodeURIComponent(song.id);
    } catch (err) { unbusy(); toast(err.message); }
  };
  sheet('Re-transcribe “' + song.title + '”', [
    { icon: 'ic-keyboard', label: MODES.piano + ' (drums removed)', run: run('piano', true) },
    { icon: 'ic-note', label: MODES.easy + ' (drums removed)', run: run('easy', true) },
    { icon: 'ic-chord', label: MODES.full + ' (for solo piano recordings)', run: run('full', false) },
    { icon: 'ic-keyboard', label: 'Transkun – piano model, very accurate (server)', run: async () => {
      try {
        const { transcribe } = await import('./transcribe.js');
        const opts = { ...transcribeOpts(), model: 'transkun', mode: 'full', drums: false };
        const r = await transcribe(await (await songAudio(song)).arrayBuffer(), (st, pct) => busy(st, pct), opts);
        Object.assign(song, { notes: r.notes, duration: r.duration, opts, best: null });
        await db.put(song);
        unbusy();
        location.hash = '#/play/' + encodeURIComponent(song.id);
      } catch (err) { unbusy(); toast(err.message, 6000); }
    } },
    { icon: 'ic-synth', label: 'MuScriptor – multi-instrument model (server)', run: async () => {
      try {
        const { transcribe } = await import('./transcribe.js');
        const opts = { ...transcribeOpts(), model: 'muscriptor', mode: 'piano' };
        const r = await transcribe(await (await songAudio(song)).arrayBuffer(), (st, pct) => busy(st, pct), opts);
        Object.assign(song, { notes: r.notes, duration: r.duration, opts, best: null });
        await db.put(song);
        unbusy();
        location.hash = '#/play/' + encodeURIComponent(song.id);
      } catch (err) { unbusy(); toast(err.message, 6000); }
    } },
  ].filter((x) => !STATIC || !/MuScriptor|Transkun/.test(x.label)));
}

async function handleLink(url) {
  if (STATIC) return toast('Links laden geht nur in der lokalen App (braucht den Keyflow-Server). Lade die Datei stattdessen mit + hoch.', 5000);
  busy('Fetching audio from link…');
  try {
    const res = await fetch('/api/fetch?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error((await res.text()) || `Download failed (${res.status})`);
    const title = decodeURIComponent(res.headers.get('x-title') || '') || new URL(url).hostname;
    const buf = await res.arrayBuffer();
    $('#askInput').value = '';
    if (/midi/.test(res.headers.get('content-type') || '')) {
      const { parseMidi } = await import('./midi.js');
      const r = await parseMidi(buf);
      return saveAndOpen({ title, notes: r.notes, duration: r.duration, source: 'link' });
    }
    await transcribeBuffer(buf, title, 'link');
  } catch (err) {
    console.error(err);
    unbusy();
    toast(err.message.includes('Failed to fetch') ? 'Links need the local server (node server.js).' : err.message, 5000);
  }
}

async function recordAndTranscribe() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch {
    return toast('Microphone permission denied');
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const started = Date.now();
  busy('Recording… play your piano or song');
  const cancel = $('#busyCancel');
  cancel.classList.remove('hidden');
  const tick = setInterval(() => ($('#busyStage').textContent = `Recording… ${fmtTime((Date.now() - started) / 1000)}`), 500);
  rec.start();
  await new Promise((res) => { cancel.onclick = res; });
  clearInterval(tick);
  cancel.classList.add('hidden');
  await new Promise((res) => { rec.onstop = res; rec.stop(); });
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: rec.mimeType });
  const d = new Date();
  try {
    await transcribeBuffer(await blob.arrayBuffer(), `Live Recording ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, 'recording');
  } catch (err) {
    unbusy();
    toast(err.message);
  }
}

async function saveAndOpen(data) {
  const song = { id: uid(), createdAt: Date.now(), lastPlayed: null, ...data };
  await db.put(song);
  unbusy();
  location.hash = '#/play/' + encodeURIComponent(song.id);
}

// ---------------- player ----------------
let currentPlayer = null, currentSong = null, hudTimer = null;
const SPEEDS = [[0.25, 'Slowest'], [0.5, 'Slower'], [0.75, 'Slow'], [1, 'Normal'], [1.25, 'Fast'], [1.5, 'Faster']];

async function openPlayer(id) {
  const song = await db.get(id);
  if (!song || song.deleted) { toast('Song not found'); location.hash = '#/library'; return; }
  show('player');
  if (currentPlayer) currentPlayer.destroy();
  currentSong = song;
  piano.ensure();
  if ((settings.sound?.bank || 'piano') !== (piano.bankId || 'piano')) await applyBank(settings.sound.bank);
  inputs.keyboardEnabled = true;
  const p = (currentPlayer = new Player($('#stage'), { ...song, notes: simplify(song.notes, settings.difficulty) }, settings, {
    onTime: updateProgress,
    onState: updateTransport,
    onEnd: showResult,
    onLoopPass: handlePass,
    onLights: (lights) => {
      if (settings.lightProto === 'off') return;
      const wanted = new Map();
      for (const [p, l] of lights) if (settings.lightAhead === 'ahead' || l.now) wanted.set(p, l);
      inputs.setLights(wanted, settings.lightProto, { silent: settings.silentLights });
    },
  }));
  p.speed = settings.speed;
  p.mode = settings.mode;
  applyHandMode(p);
  $('#npCover').style.cssText = coverStyle(song.id);
  $('#npTitle').textContent = song.title;
  layoutPlayer();
  syncHud();
  updateProgress(p.time);
  updateTransport();
  song.lastPlayed = Date.now();
  db.put(song);
  try { if (matchMedia('(pointer: coarse)').matches) await screen.orientation?.lock?.('landscape'); } catch {}
}

function closePlayer() {
  currentPlayer?.destroy();
  currentPlayer = null;
  inputs.keyboardEnabled = false;
  inputs.clearLights();
  $('#resultModal').classList.add('hidden');
  try { screen.orientation?.unlock?.(); } catch {}
}

function layoutPlayer() {
  if (!currentPlayer) return;
  currentPlayer.resize();
  const kb = currentPlayer.kbH;
  document.querySelector('.now-playing').style.bottom = kb + 14 + 'px';
  $('#endBtn').style.bottom = kb + 10 + 'px';
}
window.addEventListener('resize', () => { if (currentPlayer) { currentPlayer.computeRange(); layoutPlayer(); } });

function updateProgress(t) {
  if (!currentSong) return;
  const pct = Math.max(0, Math.min(1, t / currentSong.duration));
  $('#progressFill').style.width = pct * 100 + '%';
  $('#npTime').textContent = `${fmtTime(t)} / ${fmtTime(currentSong.duration)}`;
  const s = currentPlayer?.stats;
  if (s) $('#scoreChip').innerHTML = `${s.hit} ✓${s.streak > 2 ? ic('ic-fire') + s.streak : ''}`;
}

function updateTransport() {
  const playing = currentPlayer?.playing;
  $('#bigPlay').classList.toggle('hidden', !!playing);
  pokeHud();
}

function pokeHud() {
  const hud = $('#hud');
  hud.classList.remove('faded');
  clearTimeout(hudTimer);
  if (currentPlayer?.playing) {
    hudTimer = setTimeout(() => {
      if (currentPlayer?.playing && $$('#hud .panel').every((p) => p.classList.contains('hidden'))) hud.classList.add('faded');
    }, 3500);
  }
}

function syncHud() {
  const p = currentPlayer;
  $('#speedVal').textContent = Math.round(p.speed * 100) + '%';
  $('.speed-opts').innerHTML = SPEEDS.map(([v, l]) => `<button class="speed-opt ${v === p.speed ? 'active' : ''}" data-speed="${v}"><b>${v * 100}%</b><span>${l}</span></button>`).join('');
  $('#modeWait').classList.toggle('active', p.mode === 'wait');
  $('#modePlay').classList.toggle('active', p.mode === 'play');
  $$('#handSeg [data-hands]').forEach((b) => b.classList.toggle('active', b.dataset.hands === settings.handMode));
  $('#levelVal').textContent = LEVELS.find((l) => l.id === settings.difficulty)?.label || 'Original';
  $('#setFingerColors').checked = settings.fingerColors;
  $('#setHandDiagram').checked = settings.handDiagram;
  $('#setEditFingers').checked = settings.editFingers;
  $('#setLabels').value = settings.labels;
  $('#setKeyboard').value = settings.keyboard;
  $('#setFingers').checked = settings.fingers;
  $('#setAutoTempo').checked = settings.autoTempo;
  $('#setPassAcc').value = settings.passAcc;
  $('#setColors').value = settings.colors;
  $('#setLights').checked = settings.keyLights;
  $('#setLightProto').value = settings.lightProto;
  $('#setLightAhead').value = settings.lightAhead;
  $('#setSilentLights').checked = settings.silentLights;
  $('#sysexStatus').textContent = !inputs.midiAccess ? 'MIDI not connected yet'
    : !inputs.outputs().length ? 'no MIDI output found'
    : inputs.sysex ? '✓ ' + inputs.outputs().map((o) => o.name).join(', ') : '⚠ SysEx not allowed – proprietary modes need it';
  $('#setZoom').value = settings.zoom;
  $('#setGuide').checked = settings.guideSound;
  $('#setMute').checked = settings.muteSong;
  $('#setMidiSound').checked = settings.midiSound;
  $('#setMetro').checked = settings.metronome;
  $('#setFx').checked = settings.effects;
  $('#setVol').value = settings.volume;
  $('#micSens').value = settings.micSens;
  $('#micStatus').textContent = settings.micActive ? 'listening' : 'off';
  $('#micStatus').classList.toggle('on', settings.micActive);
  $('#midiStatus').textContent = inputs.midiDevices.length ? inputs.midiDevices.join(', ') : '';
  $('#midiStatus').classList.toggle('on', inputs.midiDevices.length > 0);
  const band = $('#loopBand');
  if (p.loop) {
    band.classList.remove('hidden');
    band.style.left = (p.loop.a / currentSong.duration) * 100 + '%';
    band.style.width = ((p.loop.b - p.loop.a) / currentSong.duration) * 100 + '%';
  } else band.classList.add('hidden');
}

function togglePanel(id) {
  $$('#hud .panel').forEach((el) => el.classList.toggle('hidden', el.id !== id || !el.classList.contains('hidden')));
  pokeHud();
}

$('#exitBtn').onclick = () => (location.hash = '#/library');
$('#endBtn').onclick = () => { if (!currentPlayer) return; currentPlayer.pause(); showResult(currentPlayer.result()); };
$('#speedBtn').onclick = () => togglePanel('speedMenu');
$('#settingsBtn').onclick = () => togglePanel('settingsPanel');
$('#practiceBtn').onclick = () => { renderSections(); togglePanel('practicePanel'); };
$('#soundBtn').onclick = () => { renderSoundPanel(); togglePanel('soundPanel'); };

// ---------------- sound library & instruments ----------------
let presetList = [];
const presetKey = (p) => `${p.isDrum ? 1 : 0}:${p.bankMSB || 0}:${p.bankLSB || 0}:${p.program || 0}`;
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');

function presetOptions() {
  const groups = new Map();
  for (const p of [...presetList].sort((a, b) => (a.isDrum - b.isDrum) || (a.bankMSB - b.bankMSB) || (a.program - b.program))) {
    const g = p.group ? p.group : p.isDrum ? 'Drums' : (p.bankMSB || p.bankLSB) ? `Varianten (Bank ${p.bankMSB}${p.bankLSB ? '/' + p.bankLSB : ''})` : GM_FAMILIES[Math.floor(p.program / 8)] || 'Andere';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  return [...groups].map(([g, ps]) => `<optgroup label="${esc(g)}">${ps.map((p) => `<option value="${presetKey(p)}">${String(p.program + 1).padStart(3, '0')} ${esc(p.name)}</option>`).join('')}</optgroup>`).join('');
}

function defaultPreset(role) {
  const want = settings.sound.presets?.[role];
  const find = (k) => presetList.find((p) => presetKey(p) === k);
  return (want && find(want)) || presetList.find((p) => !p.isDrum && !p.bankMSB && p.program === 0) || presetList[0];
}

async function applyBank(id, { quiet = false } = {}) {
  try {
    if (!quiet) busy('Lade Sound-Bibliothek …', 0);
    const list = await piano.setBank(id, (stage, pct) => { if (!quiet) busy(stage, pct); });
    presetList = list || [];
    for (const role of ['R', 'L', 'user']) piano.setRolePreset(role, defaultPreset(role));
    settings.sound.bank = id;
    saveSettings();
  } catch (e) {
    console.error(e);
    toast('Sound konnte nicht geladen werden: ' + e.message, 5000);
    await piano.setBank('piano');
    settings.sound.bank = 'piano';
    saveSettings();
  } finally {
    if (!quiet) unbusy();
  }
}

async function renderSoundPanel() {
  const banks = await soundlib.listBanks();
  $('#sndBank').innerHTML = banks.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.format ? ' · ' + b.format : ''}</option>`).join('');
  $('#sndBank').value = settings.sound.bank;
  const isSf = !!piano.alt?.setPreset;
  $('#sndPresets').classList.toggle('hidden', !isSf);
  if (isSf) {
    const opts = presetOptions();
    for (const el of $$('.snd-preset')) { el.innerHTML = opts; const p = defaultPreset(el.dataset.role); if (p) el.value = presetKey(p); }
  }
  $('#sndInfo').textContent = settings.sound.bank === 'piano' ? 'Hochwertiger Konzertflügel. Für andere Instrumente eine SoundFont wählen.'
    : piano.alt && piano.alt === piano.fm ? `${presetList.length} FM-Sounds (DX7-kompatibel) – für jede Hand und deine Tasten einzeln wählbar.`
    : isSf ? `${presetList.length} Instrumente/Presets in dieser Bibliothek.`
    : piano.sfzInfo ? `SFZ: ${piano.sfzInfo.regions} Regionen, ${piano.sfzInfo.samples} Samples${piano.sfzInfo.missing ? ` · ⚠ ${piano.sfzInfo.missing} Samples fehlen` : ''}` : '';
  $('#sndExportSyx').classList.toggle('hidden', !(piano.alt && piano.alt === piano.fm));
  renderCustomList();
  renderMidiOut();
  const sx = await soundlib.listSysex();
  $('#syxList').innerHTML = sx.length ? '<p class="panel-title" style="margin-top:12px">SYSEX-BEFEHLE</p>' + sx.map((x) => `<div class="snd-item col">
      <span>${esc(x.name)} <span class="muted small">${x.count} Nachricht(en)</span></span>
      <span class="muted small">${x.info.map(esc).join('<br>')}${x.count > x.info.length ? '<br>…' : ''}</span>
      <span class="row btns">${parseSyx(new Uint8Array(x.messages.flat()).buffer).voices.length ? `<button class="glass pill" data-syx-presets="${esc(x.id)}">${ic('ic-synth')} Als Presets übernehmen</button>` : ''}<button class="glass pill" data-syx-piano="${esc(x.id)}">${ic('ic-keyboard')} An Piano senden</button><button class="glass pill" data-syx-synth="${esc(x.id)}">${ic('ic-sound')} An Sound-Engine</button><button class="link small" data-del-bank="${esc(x.id)}">Löschen</button></span>
    </div>`).join('') : '';
  const imported = banks.filter((b) => !b.builtin);
  $('#sndList').innerHTML = imported.length ? imported.map((b) => `<div class="snd-item"><span>${esc(b.name)} <span class="muted small">${b.format} · ${fmtSize(b.size)}</span></span><button class="link small" data-del-bank="${esc(b.id)}">Löschen</button></div>`).join('') : '';
}

// ---------- MIDI out: VST3 hosts / DAWs / hardware ----------
const GM_NAMES = ["Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano", "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet", "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer", "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion", "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)", "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics", "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2", "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani", "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit", "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2", "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet", "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina", "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)", "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)", "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)", "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai", "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal", "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot"];
const MO_ROLES = [['R', 'moR', 'moRch'], ['L', 'moL', 'moLch'], ['user', 'moU', 'moUch']];
piano.setExternalRoute((role) => {
  const mo = settings.midiOut;
  if (!mo || mo.device === 'off' || !inputs.midiAccess) return null;
  const r = mo[role];
  if (!r?.on) return null;
  return { channel: r.ch, exclusive: mo.exclusive, send: (m) => inputs.sendTo(mo.device, m) };
});
function sendPrograms() {
  const mo = settings.midiOut;
  if (mo.device === 'off' || mo.program < 0 || !inputs.midiAccess) return;
  for (const [role] of MO_ROLES) if (mo[role].on) inputs.sendTo(mo.device, [0xc0 | mo[role].ch, mo.program]);
}
function renderMidiOut() {
  const mo = settings.midiOut;
  const outs = inputs.midiAccess ? inputs.outputList() : [];
  $('#moDevice').innerHTML = '<option value="off">Aus</option>' + (outs.length ? '<option value="all">Alle Ausgänge</option>' : '') +
    outs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
  if (mo.device !== 'off' && mo.device !== 'all' && !outs.some((o) => o.id === mo.device)) $('#moDevice').insertAdjacentHTML('beforeend', `<option value="${esc(mo.device)}">(nicht verbunden)</option>`);
  $('#moDevice').value = mo.device;
  $('#moOpts').classList.toggle('hidden', mo.device === 'off');
  for (const [role, cb, ch] of MO_ROLES) { $('#' + cb).checked = mo[role].on; $('#' + ch).value = mo[role].ch; }
  $('#moProg').innerHTML = '<option value="-1">– nichts senden –</option>' + GM_NAMES.map((n, i) => `<option value="${i}">${String(i + 1).padStart(3, '0')} ${n}</option>`).join('');
  $('#moProg').value = mo.program;
  $('#moExcl').checked = mo.exclusive;
}
const saveMo = () => { piano.stopAll(); saveSettings(); renderMidiOut(); };
$('#moScan').onclick = async () => {
  try { await inputs.enableMidi(); } catch (e) { return toast(e.message, 4000); }
  renderMidiOut();
  toast(inputs.outputList().length ? `Gefunden: ${inputs.outputList().map((o) => o.name).join(', ')}` : 'Kein MIDI-Ausgang gefunden – Gerät/virtuelles Kabel verbinden', 4000, 'ic-keyboard');
};
$('#moDevice').onchange = async (e) => {
  if (e.target.value !== 'off') { try { await inputs.enableMidi(); } catch (err) { toast(err.message, 4000); } }
  settings.midiOut.device = e.target.value; saveMo(); sendPrograms();
};
for (const [role, cb, ch] of MO_ROLES) {
  $('#' + cb).onchange = (e) => { settings.midiOut[role].on = e.target.checked; saveMo(); sendPrograms(); };
  $('#' + ch).onchange = (e) => { settings.midiOut[role].ch = +e.target.value; saveMo(); sendPrograms(); };
}
$('#moProg').onchange = (e) => { settings.midiOut.program = +e.target.value; saveMo(); sendPrograms(); };
$('#moExcl').onchange = (e) => { settings.midiOut.exclusive = e.target.checked; saveMo(); };

$('#sndBank').addEventListener('change', async (e) => { await applyBank(e.target.value); renderSoundPanel(); });
$$('.snd-preset').forEach((el) => el.addEventListener('change', () => {
  const p = presetList.find((x) => presetKey(x) === el.value);
  if (!p) return;
  settings.sound.presets = { ...settings.sound.presets, [el.dataset.role]: el.value };
  saveSettings();
  piano.setRolePreset(el.dataset.role, p);
  if (el.dataset.role === 'user') piano.play(60, 0.7, 0.6, 'preview', 'user');
  else piano.play(el.dataset.role === 'L' ? 48 : 72, 0.7, 0.6, 'preview', el.dataset.role);
}));
$('#sndImport').onclick = () => { $('#sndFile').accept = soundlib.ACCEPT; $('#sndFile').click(); };
$('#sndImportDir').onclick = () => $('#sndDir').click();
async function doImport(files) {
  if (!files?.length) return;
  try {
    busy('Importiere …');
    const { added, skipped } = await soundlib.importFiles([...files], (st) => busy(st));
    unbusy();
    if (added.length) {
      toast(`✓ ${added.length} Sound-Bibliothek(en) importiert: ${added.map((a) => a.name).join(', ')}`, 4000);
      await applyBank(added[0].id);
    }
    if (skipped.length) toast('Nicht importiert: ' + skipped.join('; '), 6000);
  } catch (e) {
    unbusy();
    toast('Import fehlgeschlagen: ' + e.message, 5000);
  }
  renderSoundPanel();
}
const importPicked = async (e) => {
  busy('Lese Dateien …');
  let files;
  try { files = await snapshotFiles(e.target.files); } catch (err) { unbusy(); return toast('Dateien konnten nicht gelesen werden: ' + err.message, 6000); }
  finally { e.target.value = ''; }
  doImport(files);
};
$('#sndFile').onchange = importPicked;
$('#sndDir').onchange = importPicked;
// ---------- custom .syx preset import ----------
let picked = [];
$('#sndImportSyx').onclick = () => $('#syxFile').click();
$('#syxFile').onchange = async (e) => {
  let files;
  try { files = await snapshotFiles(e.target.files); } catch (err) { return toast('Datei konnte nicht gelesen werden: ' + err.message, 6000); }
  finally { e.target.value = ''; }
  if (!files.length) return;
  try {
    busy('Lese .syx-Presets …');
    picked = (await soundlib.readSyxVoices(files)).map((x) => ({ ...x, on: true }));
    unbusy();
  } catch (err) { unbusy(); return toast('Konnte .syx nicht lesen: ' + err.message, 5000); }
  if (!picked.length) return toast('Keine FM-Presets (DX7 oder reface DX) in dieser Datei gefunden. Andere SysEx-Befehle importierst du über „SoundFont importieren“.', 7000);
  openPicker(files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'Meine Bank');
};
function openPicker(defaultName) {
  $('#pickName').value = defaultName;
  $('#pickSearch').value = '';
  renderPicker();
  $('#syxPicker').classList.remove('hidden');
}
function renderPicker() {
  const q = $('#pickSearch').value.toLowerCase();
  const sources = new Set(picked.map((p) => p.source));
  $('#pickInfo').textContent = `${picked.length} Presets aus ${sources.size} Datei(en) · ${picked.filter((p) => p.on).length} ausgewählt`;
  $('#pickList').innerHTML = picked.map((p, i) => (!q || p.voice.name.toLowerCase().includes(q) || p.source.toLowerCase().includes(q))
    ? `<label class="pick-item"><input type="checkbox" data-pick="${i}" ${p.on ? 'checked' : ''}/><span class="pick-name">${esc(p.voice.name)}</span><span class="muted small">${esc(p.source)} #${p.index}</span><button class="link small" data-audition="${i}">▶</button></label>` : '').join('');
}
$('#pickSearch').addEventListener('input', renderPicker);
$('#pickAll').onclick = () => { picked.forEach((p) => (p.on = true)); renderPicker(); };
$('#pickNone').onclick = () => { picked.forEach((p) => (p.on = false)); renderPicker(); };
$('#pickTarget').onchange = () => $('#pickName').classList.toggle('hidden', $('#pickTarget').value !== 'new');
$('#pickList').addEventListener('change', (e) => { const i = e.target.dataset.pick; if (i != null) { picked[+i].on = e.target.checked; renderPicker(); } });
$('#pickList').addEventListener('click', async (e) => {
  const i = e.target.closest('[data-audition]')?.dataset.audition;
  if (i == null) return;
  e.preventDefault();
  // audition: load the single voice into the FM engine temporarily on the "user" channel
  const v = picked[+i].voice;
  if (!piano.fm) { const { FMEngine } = await import('./fm-engine.js'); piano.ensure(); piano.fm = new FMEngine(piano.ctx, piano.master); }
  await piano.fm.init();
  piano.fm.node.port.postMessage({ type: 'patch', role: 'audition', patch: v });
  [60, 64, 67].forEach((n, k) => setTimeout(() => {
    piano.fm.node.port.postMessage({ type: 'on', id: 'aud' + n, note: n, vel: 100, role: 'audition' });
    setTimeout(() => piano.fm.node.port.postMessage({ type: 'off', id: 'aud' + n }), 700);
  }, k * 120));
});
$('#pickCancel').onclick = () => $('#syxPicker').classList.add('hidden');
$('#pickOk').onclick = async () => {
  const voices = picked.filter((p) => p.on).map((p) => p.voice);
  if (!voices.length) return toast('Bitte mindestens ein Preset auswählen');
  let bankId;
  if ($('#pickTarget').value === 'new') bankId = (await soundlib.saveVoicesAsBank($('#pickName').value.trim() || 'Meine Bank', voices)).id;
  else { await soundlib.addToCustom(voices); bankId = soundlib.CUSTOM_ID; }
  $('#syxPicker').classList.add('hidden');
  toast(`✓ ${voices.length} Preset(s) importiert`);
  await applyBank(bankId);
  renderSoundPanel();
};

async function renderCustomList() {
  const box = $('#customList');
  const show = settings.sound.bank === soundlib.CUSTOM_ID;
  box.classList.toggle('hidden', !show);
  if (!show) return;
  const { voices } = await soundlib.getCustom();
  box.innerHTML = '<p class="panel-title" style="margin-top:12px">MEINE FM-PRESETS</p>' + voices.map((v, i) => `<div class="snd-item"><span>${String(i + 1).padStart(2, '0')} ${esc(v.name)}</span><span><button class="link small" data-c-up="${i}">↑</button> <button class="link small" data-c-ren="${i}">Umbenennen</button> <button class="link small" data-c-del="${i}">Entfernen</button></span></div>`).join('');
}
$('#customList').onclick = async (e) => {
  const d = e.target.dataset;
  if (d.cUp == null && d.cRen == null && d.cDel == null) return;
  const { voices } = await soundlib.getCustom();
  if (d.cDel != null) voices.splice(+d.cDel, 1);
  else if (d.cUp != null && +d.cUp > 0) [voices[+d.cUp - 1], voices[+d.cUp]] = [voices[+d.cUp], voices[+d.cUp - 1]];
  else if (d.cRen != null) {
    const n = prompt('Neuer Name (max. 10 Zeichen, DX7-Format)', voices[+d.cRen].name);
    if (!n) return;
    voices[+d.cRen].name = n.trim().slice(0, 10).toUpperCase();
  }
  await soundlib.saveCustom(voices);
  if (!voices.length) { await applyBank('piano', { quiet: true }); } else await applyBank(soundlib.CUSTOM_ID, { quiet: true });
  renderSoundPanel();
};

$('#sndExportSyx').onclick = async () => {
  const { encodeBank, encodeReface } = await import('./dx7.js');
  const all = piano.fm?.voices || [];
  if (!all.length) return;
  const refaceVoices = all.filter((v) => v.kind === 'reface');
  const voices = all.filter((v) => v.kind !== 'reface');
  if (refaceVoices.length) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([encodeReface(refaceVoices)], { type: 'application/octet-stream' }));
    a.download = ($('#sndBank').selectedOptions[0]?.textContent.split(' – ')[0].split(' · ')[0] || 'keyflow').replace(/[^\w-]+/g, '_') + '_refaceDX.syx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    if (!voices.length) return;
  }
  const name = ($('#sndBank').selectedOptions[0]?.textContent.split(' – ')[0].split(' · ')[0] || 'keyflow-fm').replace(/[^\w-]+/g, '_');
  const parts = Math.ceil(voices.length / 32);
  for (let i = 0; i < parts; i++) {
    // a DX7 bank always holds 32 voices; shorter sets are padded by repeating
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([encodeBank(voices.slice(i * 32, i * 32 + 32))], { type: 'application/octet-stream' }));
    a.download = name + (parts > 1 ? `_${i + 1}` : '') + '.syx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    await new Promise((r) => setTimeout(r, 300));
  }
};
$('#syxList').onclick = async (e) => {
  const presetsId = e.target.closest('[data-syx-presets]')?.dataset.syxPresets;
  if (presetsId) {
    const x = (await soundlib.listSysex()).find((s) => s.id === presetsId);
    const { voices } = parseSyx(new Uint8Array(x.messages.flat()).buffer);
    picked = voices.map((v, i) => ({ voice: v, source: x.name, index: i + 1, on: true }));
    return openPicker(x.name);
  }
  const pianoId = e.target.closest('[data-syx-piano]')?.dataset.syxPiano;
  const synthId = e.target.closest('[data-syx-synth]')?.dataset.syxSynth;
  const id = pianoId || synthId;
  if (!id) return $('#sndList').onclick(e);
  const x = (await soundlib.listSysex()).find((s) => s.id === id);
  if (!x) return;
  try {
    if (pianoId) {
      const to = await inputs.sendSysex(x.messages);
      toast(`✓ ${x.count} SysEx-Nachricht(en) gesendet an ${to.join(', ')}`);
    } else {
      if (!(piano.alt && piano.alt === piano.sf)) return toast('Bitte zuerst eine SoundFont (z. B. GeneralUser GS) als Sound wählen');
      for (const m of x.messages) piano.sf.synth.systemExclusive(m.slice(1));
      toast(`✓ ${x.count} SysEx-Nachricht(en) auf die Sound-Engine angewendet`);
    }
  } catch (err) { toast(err.message, 5000); }
};
$('#sndList').onclick = async (e) => {
  const id = e.target.closest('[data-del-bank]')?.dataset.delBank;
  if (!id || !confirm('Diese Sound-Bibliothek löschen?')) return;
  await soundlib.deleteBank(id);
  if (settings.sound.bank === id) await applyBank('piano', { quiet: true });
  renderSoundPanel();
};

// ---------------- practice by section ----------------
let practice = null; // {songId, sections, index, mastered:Set}
function renderSections() {
  const p = currentPlayer;
  if (!p) return;
  if (!practice || practice.songId !== currentSong.id) practice = { songId: currentSong.id, sections: p.sections(), index: -1, mastered: new Set() };
  $('#sectionList').innerHTML = practice.sections.map((sec, i) => `<button class="section-btn ${i === practice.index ? 'active' : ''} ${practice.mastered.has(i) ? 'done' : ''}" data-sec="${i}">
      <b>${practice.mastered.has(i) ? '✓ ' : ''}Part ${i + 1}</b>${fmtTime(Math.max(0, sec.a))}–${fmtTime(Math.min(currentSong.duration, sec.b))}</button>`).join('');
}
$('#sectionList').onclick = (e) => {
  const b = e.target.closest('[data-sec]');
  if (!b) return;
  const p = currentPlayer;
  practice.index = +b.dataset.sec;
  p.loop = { ...practice.sections[practice.index] };
  if (settings.autoTempo) p.speed = 0.5;
  p.stats = { hit: 0, miss: 0, wrong: 0, streak: 0, best: 0 };
  p.seek(Math.max(-2, p.loop.a - 1));
  syncHud(); renderSections(); togglePanel(null);
  p.play();
  toast(`Part ${practice.index + 1}${settings.autoTempo ? ' – starting at 50 % speed' : ''}`);
};
$('#practiceStop').onclick = () => {
  if (!currentPlayer) return;
  currentPlayer.loop = null;
  if (practice) practice.index = -1;
  currentPlayer.speed = settings.speed;
  syncHud(); renderSections(); togglePanel(null);
};
function handlePass(r) {
  const p = currentPlayer;
  if (!practice || practice.index < 0 || !r.total) return;
  const clean = r.accuracy >= settings.passAcc;
  if (!settings.autoTempo) { toast(`Pass: ${r.accuracy}%`); return; }
  if (clean && p.speed >= 1) {
    practice.mastered.add(practice.index);
    const next = practice.index + 1;
    if (next < practice.sections.length) {
      toast(`Part ${practice.index + 1} mastered (${r.accuracy}%) – on to part ${next + 1}!`, 3500, 'ic-trophy');
      practice.index = next;
      p.loop = { ...practice.sections[next] };
      p.speed = 0.5;
    } else {
      toast('All parts mastered! Try the whole song at 100 %.', 4000, 'ic-trophy');
      p.loop = null; practice.index = -1; p.speed = 1;
    }
  } else if (clean) {
    p.speed = Math.min(1, Math.round((p.speed + 0.1) * 100) / 100);
    toast(`✓ ${r.accuracy}% – speed up to ${Math.round(p.speed * 100)} %`);
  } else if (r.accuracy < 50 && p.speed > 0.3) {
    p.speed = Math.max(0.3, Math.round((p.speed - 0.1) * 100) / 100);
    toast(`${r.accuracy}% – slowing down to ${Math.round(p.speed * 100)} %`);
  } else {
    toast(`${r.accuracy}% – again! Need ${settings.passAcc}%`);
  }
  p.stats.hit = p.stats.miss = p.stats.wrong = 0;
  syncHud(); renderSections();
}
$('#inputBtn').onclick = () => togglePanel('inputMenu');
$('.speed-opts').onclick = (e) => {
  const b = e.target.closest('[data-speed]');
  if (!b) return;
  currentPlayer.speed = settings.speed = +b.dataset.speed;
  saveSettings(); syncHud();
};
$('#modeWait').onclick = () => { currentPlayer.mode = settings.mode = 'wait'; saveSettings(); syncHud(); toast('Wait Mode: the song pauses until you play the right notes'); };
$('#modePlay').onclick = () => { currentPlayer.mode = settings.mode = 'play'; saveSettings(); syncHud(); };
function applyHandMode(p = currentPlayer) {
  if (!p) return;
  const m = settings.handMode;
  p.hands = { L: m === 'L' || m === 'both', R: m === 'R' || m === 'both' };
}
$('#handSeg').onclick = (e) => {
  const b = e.target.closest('[data-hands]');
  if (!b || !currentPlayer) return;
  settings.handMode = b.dataset.hands;
  saveSettings();
  applyHandMode();
  piano.stopAll();
  syncHud();
  const other = { auto: 'spielt automatisch', mute: 'ist stumm', hide: 'ist ausgeblendet' }[settings.otherHand];
  toast({ L: `Nur linke Hand – die rechte ${other}`, R: `Nur rechte Hand – die linke ${other}`, both: 'Beide Hände üben', none: 'Zuhören – beide Hände spielen automatisch' }[settings.handMode], 2600,
    settings.handMode === 'L' ? 'ic-hand-left' : settings.handMode === 'R' ? 'ic-hand-right' : null);
};

// ---------- difficulty levels ----------
function rebuildPlayer() {
  if (!currentPlayer || !currentSong) return;
  const keep = { time: currentPlayer.time, speed: currentPlayer.speed, mode: currentPlayer.mode, loop: currentPlayer.loop, playing: currentPlayer.playing };
  currentPlayer.destroy();
  const hooks = currentPlayer.hooks;
  currentPlayer = new Player($('#stage'), { ...currentSong, notes: simplify(currentSong.notes, settings.difficulty) }, settings, hooks);
  Object.assign(currentPlayer, { speed: keep.speed, mode: keep.mode, loop: keep.loop });
  applyHandMode();
  currentPlayer.seek(keep.time);
  if (practice) practice.songId = null; // sections depend on the arrangement
  layoutPlayer();
  if (keep.playing) currentPlayer.play();
  syncHud();
}
function renderLevelPanel() {
  const r = rate(currentSong.notes, currentSong.duration);
  const cur = simplify(currentSong.notes, settings.difficulty);
  $('#levelRating').innerHTML = `Song-Bewertung: <b>${r.label}</b> (${r.score}/10) · aktuell ${cur.length} von ${currentSong.notes.length} Noten`;
  $('#levelOpts').innerHTML = LEVELS.map((l) => {
    const n = simplify(currentSong.notes, l.id).length;
    return `<button class="speed-opt ${l.id === settings.difficulty ? 'active' : ''}" data-level="${l.id}"><b>${l.label}</b><span>${n} Noten</span></button>`;
  }).join('');
  $('#setOtherHand').value = settings.otherHand;
}
$('#levelBtn').onclick = () => { renderLevelPanel(); togglePanel('levelPanel'); };
$('#levelOpts').onclick = (e) => {
  const b = e.target.closest('[data-level]');
  if (!b) return;
  settings.difficulty = b.dataset.level;
  saveSettings();
  rebuildPlayer();
  renderLevelPanel();
  toast(`Level: ${LEVELS.find((l) => l.id === settings.difficulty).label}`);
};
$('#setOtherHand').onchange = (e) => { settings.otherHand = e.target.value; saveSettings(); piano.stopAll(); };
const bindSetting = (sel, key, prop = 'checked', after) => {
  $(sel).addEventListener('input', (e) => {
    settings[key] = prop === 'value' ? (isNaN(+e.target.value) ? e.target.value : +e.target.value) : e.target.checked;
    saveSettings();
    after?.();
  });
};
bindSetting('#setLabels', 'labels', 'value');
bindSetting('#setKeyboard', 'keyboard', 'value', () => { currentPlayer.computeRange(); layoutPlayer(); });
bindSetting('#setColors', 'colors', 'value');
bindSetting('#setFingers', 'fingers');
bindSetting('#setFingerColors', 'fingerColors');
bindSetting('#setHandDiagram', 'handDiagram');
bindSetting('#setEditFingers', 'editFingers', 'checked', () => { if (settings.editFingers) { currentPlayer?.pause(); toast('Pausiert: tippe auf eine Note, um den Finger zu ändern (1→5→automatisch)', 4500); } });
bindSetting('#setAutoTempo', 'autoTempo');
bindSetting('#setPassAcc', 'passAcc', 'value');
bindSetting('#setLights', 'keyLights');
$('#setLightProto').innerHTML = LIGHT_PROTOCOLS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
async function ensureLightOutput() {
  try { await inputs.enableMidi(); } catch (e) { toast(e.message, 4000); return false; }
  if (!inputs.outputs().length) { toast('No MIDI output found – connect your piano via USB or Bluetooth MIDI'); return false; }
  return true;
}
bindSetting('#setLightProto', 'lightProto', 'value', async () => {
  inputs.clearLights();
  if (settings.lightProto !== 'off') await ensureLightOutput();
  syncHud();
});
bindSetting('#setLightAhead', 'lightAhead', 'value');
bindSetting('#setSilentLights', 'silentLights');
$('#testLightsBtn').onclick = async () => {
  if (settings.lightProto === 'off') return toast('Choose a key-light mode first');
  if (!(await ensureLightOutput())) return;
  syncHud();
  toast('Lighting C4 → C5 → C4 … do the keys light up?', 3500);
  inputs.clearLights();
  await inputs.testLights(settings.lightProto, { silent: settings.silentLights });
};
bindSetting('#setZoom', 'zoom', 'value', layoutPlayer);
bindSetting('#setGuide', 'guideSound');
bindSetting('#setMute', 'muteSong');
bindSetting('#setMidiSound', 'midiSound');
bindSetting('#setMetro', 'metronome');
bindSetting('#setFx', 'effects');
bindSetting('#setVol', 'volume', 'value', () => piano.setVolume(settings.volume));
bindSetting('#micSens', 'micSens', 'value', () => { if (inputs.mic) inputs.mic.sensitivity = settings.micSens; });

$('#loopA').onclick = () => { const p = currentPlayer; const t = Math.max(0, p.time); p.loop = { a: t, b: Math.max(t + 1, p.loop?.b ?? currentSong.duration) }; syncHud(); toast('Loop start set'); };
$('#loopB').onclick = () => { const p = currentPlayer; const a = p.loop?.a ?? 0; p.loop = { a, b: Math.max(a + 1, p.time) }; syncHud(); toast('Loop end set'); };
$('#loopClear').onclick = () => { currentPlayer.loop = null; syncHud(); };
$('#restartBtn').onclick = () => { currentPlayer.restart(); togglePanel(null); };
$('#exportBtn').onclick = async () => (await import('./midi.js')).exportMidi(currentSong);

$('#midiBtn').onclick = async () => {
  try {
    const devs = await inputs.enableMidi();
    toast(devs.length ? `Connected: ${devs.join(', ')}` : 'MIDI enabled – plug in your keyboard (USB/Bluetooth)');
  } catch (e) { toast(e.message, 4000); }
  syncHud();
};
$('#micBtn').onclick = async () => {
  if (settings.micActive) {
    inputs.disableMic();
    settings.micActive = false;
  } else {
    try {
      await inputs.enableMic(settings.micSens);
      settings.micActive = true;
      toast('Listening to your piano – practiced-hand guide sound is muted', 2800, 'ic-mic');
    } catch { toast('Microphone permission denied'); }
  }
  syncHud();
};

inputs.on((type, p, v, source) => {
  if (type === 'devices') { if (currentPlayer) syncHud(); return; }
  if (!currentPlayer) return;
  if (type === 'on') currentPlayer.noteOn(p, v, source);
  else currentPlayer.noteOff(p, source);
});

// progress bar seeking
(() => {
  const bar = $('#progress');
  let drag = false;
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    currentPlayer.seek(f * currentSong.duration);
    updateProgress(currentPlayer.time);
  };
  bar.addEventListener('pointerdown', (e) => { drag = true; bar.setPointerCapture(e.pointerId); seek(e); });
  bar.addEventListener('pointermove', (e) => drag && seek(e));
  bar.addEventListener('pointerup', () => (drag = false));
})();

// canvas: touch keyboard + tap to play/pause + drag to scrub
(() => {
  const cv = $('#stage');
  const ptrs = new Map(); // pointerId -> {key, scrubY, t0}
  cv.addEventListener('pointerdown', (e) => {
    if (!currentPlayer) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    cv.setPointerCapture(e.pointerId);
    if (settings.editFingers && !currentPlayer.playing && y < currentPlayer.hitY) {
      const n = currentPlayer.noteAt(x, y);
      if (n) {
        const next = !n.fm ? 1 : n.f >= 5 ? null : n.f + 1; // auto → 1 → … → 5 → auto
        const orig = currentSong.notes[n.oi];
        if (next == null) { delete n.fm; delete orig.fm; delete orig.f; } else { n.f = next; n.fm = true; orig.f = next; orig.fm = true; }
        currentPlayer.refinger();
        db.put(currentSong);
        toast(next == null ? 'Finger: automatisch' : `Finger ${next} (von Hand gesetzt)`, 1500);
        return;
      }
    }
    const key = currentPlayer.keyAt(x, y);
    if (key != null) {
      ptrs.set(e.pointerId, { key });
      inputs.emit('on', key, 0.75, 'touch');
    } else {
      ptrs.set(e.pointerId, { scrubY: y, t0: currentPlayer.time, moved: false });
    }
    pokeHud();
  });
  cv.addEventListener('pointermove', (e) => {
    const st = ptrs.get(e.pointerId);
    if (!st || !currentPlayer) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (st.key != null) {
      const k = currentPlayer.keyAt(x, Math.max(y, currentPlayer.hitY + 1));
      if (k !== st.key) { inputs.emit('off', st.key, 0, 'touch'); st.key = k; inputs.emit('on', k, 0.75, 'touch'); }
    } else if (Math.abs(y - st.scrubY) > 8 || st.moved) {
      st.moved = true;
      currentPlayer.seek(st.t0 + (y - st.scrubY) / currentPlayer.pps);
      updateProgress(currentPlayer.time);
    }
  });
  const up = (e) => {
    const st = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!st || !currentPlayer) return;
    if (st.key != null) inputs.emit('off', st.key, 0, 'touch');
    else if (!st.moved) {
      if ($$('#hud .panel').some((p) => !p.classList.contains('hidden'))) togglePanel(null);
      else currentPlayer.toggle();
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
})();
$('#bigPlay').onclick = () => currentPlayer?.play();
window.addEventListener('keydown', (e) => {
  if (!currentPlayer || e.target.closest?.('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); currentPlayer.toggle(); }
  if (e.code === 'ArrowLeft') currentPlayer.seek(currentPlayer.time - 5);
  if (e.code === 'ArrowRight') currentPlayer.seek(currentPlayer.time + 5);
  if (e.code === 'Escape') location.hash = '#/library';
});

async function showResult(res) {
  $('#resAcc').textContent = res.accuracy;
  $('#resHit').textContent = res.hit;
  $('#resMiss').textContent = res.miss;
  $('#resWrong').textContent = res.wrong;
  $('#resStreak').textContent = res.best;
  $('#resultModal').classList.remove('hidden');
  if (res.hit > 0 && currentSong) {
    currentSong.best = Math.max(currentSong.best || 0, res.accuracy);
    await db.put(currentSong);
  }
}
$('#resAgain').onclick = () => { $('#resultModal').classList.add('hidden'); currentPlayer.restart(); currentPlayer.play(); };
$('#resLib').onclick = () => (location.hash = '#/library');

// ---------------- accuracy against a reference (e.g. Songscription export) ----------------
function measureAccuracy(song) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mid,.midi,audio/midi,.musicxml,.xml,.mxl';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      busy('Vergleiche Note für Note …');
      const buf = await f.arrayBuffer();
      const ref = /\.(musicxml|mxl|xml)$/i.test(f.name)
        ? (await (await import('./musicxml.js')).parseMusicXML(buf, f.name)).notes
        : (await (await import('./midi.js')).parseMidi(buf)).notes;
      await new Promise((r) => setTimeout(r, 30));
      const { compare } = await import('./compare.js');
      const r = compare(song.notes, ref);
      unbusy();
      const pct = (x) => (x * 100).toFixed(1) + ' %';
      sheet(`Genauigkeit: „${song.title}“ vs. ${f.name}`, [
        { icon: 'ic-trophy', label: `Note-genau (F1): ${pct(r.f1)}  ·  ${r.matched} von ${r.ref} Referenz-Noten getroffen`, run() {} },
        { label: `Precision ${pct(r.precision)} (wie viele Keyflow-Noten stimmen) · Recall ${pct(r.recall)} (wie viele Referenz-Noten gefunden)`, run() {} },
        { label: `Ohne Oktavfehler: ${pct(r.pitchClassF1)} · Ø Timing-Abweichung ${r.meanOnsetErrorMs?.toFixed(0) ?? '–'} ms · Versatz ${r.offset.toFixed(2)} s, Tempo ×${r.scale.toFixed(3)}`, run() {} },
      ]);
    } catch (e) { unbusy(); toast('Vergleich fehlgeschlagen: ' + e.message, 6000); }
  };
  input.click();
}

// ---------------- sheet music (audio → notation) ----------------
const OSMD = 'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@2.3.1/build/opensheetmusicdisplay.min.js';
let scoreSong = null, scoreA = null, osmd = null;
function loadOsmd() {
  if (window.opensheetmusicdisplay) return Promise.resolve(window.opensheetmusicdisplay);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = OSMD;
    s.onload = () => res(window.opensheetmusicdisplay);
    s.onerror = () => rej(new Error('Noten-Bibliothek konnte nicht geladen werden (offline?)'));
    document.head.appendChild(s);
  });
}
const scoreNotes = () => simplify(scoreSong.notes, $('#scLevel').value);
function scoreXml() { return toMusicXML(scoreNotes(), scoreA, scoreSong.title); }
async function renderScore() {
  const box = $('#scoreBox');
  $('#scBpm').value = scoreA.bpm;
  $('#scBeats').value = scoreA.beats;
  $('#scKey').value = `${scoreA.key.fifths}:${scoreA.key.mode}`;
  $('#scoreInfo').textContent = ` · ${scoreA.key.name || ''} · ${scoreA.beats}/4 · ${scoreA.bpm} BPM`;
  try {
    const lib = await loadOsmd();
    if (!osmd) { box.innerHTML = ''; osmd = new lib.OpenSheetMusicDisplay(box, { autoResize: true, backend: 'svg', drawTitle: true, drawComposer: true, drawingParameters: 'compacttight' }); }
    await osmd.load(scoreXml());
    osmd.render();
  } catch (e) { console.error(e); box.innerHTML = `<p class="muted">Notenblatt konnte nicht dargestellt werden: ${esc(e.message)}. MusicXML-Export funktioniert trotzdem.</p>`; }
}
async function openScore(id) {
  const song = await db.get(id);
  if (!song || song.deleted) { toast('Song nicht gefunden'); location.hash = '#/library'; return; }
  show('score');
  scoreSong = song;
  $('#scoreTitle').textContent = song.title;
  $('#scLevel').value = settings.difficulty;
  // built-in songs know their tempo; transcriptions get tempo, metre and key detected; user edits are remembered
  scoreA = song.score || analyze(song.notes, { bpm: song.bpm });
  renderScore();
}
function saveScoreSettings() { scoreSong.score = scoreA; db.put(scoreSong); renderScore(); }
$('#scBpm').onchange = (e) => { scoreA = { ...scoreA, bpm: Math.max(30, Math.min(260, +e.target.value || 100)) }; saveScoreSettings(); };
$('#scBeats').onchange = (e) => { scoreA = { ...scoreA, beats: +e.target.value }; saveScoreSettings(); };
$('#scKey').onchange = (e) => {
  const [fifths, mode] = e.target.value.split(':');
  scoreA = { ...scoreA, key: { ...scoreA.key, fifths: +fifths, mode, name: e.target.selectedOptions[0].textContent } };
  saveScoreSettings();
};
$('#scLevel').onchange = () => renderScore();
$('#scAuto').onclick = () => { scoreA = analyze(scoreSong.notes, { bpm: scoreSong.bpm }); delete scoreSong.score; db.put(scoreSong); renderScore(); toast('Tempo, Takt und Tonart neu erkannt'); };
const download = (data, name, type) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
const safeName = () => scoreSong.title.replace(/[^\w\- äöüÄÖÜß]+/g, '').trim() || 'noten';
$('#scXml').onclick = () => download(scoreXml(), safeName() + '.musicxml', 'application/vnd.recordare.musicxml+xml');
$('#scMidi').onclick = async () => (await import('./midi.js')).exportMidi({ ...scoreSong, notes: scoreNotes() });
$('#scPrint').onclick = () => window.print();
$('#scoreBack').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/library');
$('#scorePlay').onclick = () => (location.hash = '#/play/' + encodeURIComponent(scoreSong.id));
$('#sheetBtn').onclick = () => { if (currentSong) location.hash = '#/score/' + encodeURIComponent(currentSong.id); };

// ---------------- account & sync ----------------
function renderAccount(state) {
  const acc = sync.getAccount();
  $('#accountLabel').textContent = acc ? acc.username : 'Sign in';
  $('#accOut').classList.toggle('hidden', !!acc);
  $('#accIn').classList.toggle('hidden', !acc);
  if (acc) $('#accName').textContent = acc.username;
  const dot = $('#syncDot');
  dot.className = 'sync-dot' + (!acc ? '' : state?.state === 'syncing' ? ' busy' : state?.state === 'error' ? ' err' : ' ok');
  if (state?.state === 'synced') $('#accStatus').textContent = `Synced ${new Date(state.at).toLocaleTimeString()} · ↓${state.pulled} ↑${state.pushed}`;
  if (state?.state === 'error') $('#accStatus').textContent = '⚠ ' + state.message;
}
sync.onSyncState((st) => { renderAccount(st); if (st.state === 'synced' && st.pulled && !currentPlayer) renderLibrary(); });
$('#accountBtn').onclick = () => { renderAccount(); renderUsage(); $('#accountModal').classList.remove('hidden'); };
$('#accClose').onclick = () => $('#accountModal').classList.add('hidden');
let accMode = 'login';
$$('#accForm button[type=submit]').forEach((b) => b.addEventListener('click', () => (accMode = b.dataset.mode)));
$('#accForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#accErr').textContent = '';
  try {
    await sync.login($('#accUser').value, $('#accPass').value, accMode === 'register');
    $('#accPass').value = '';
    renderAccount();
    renderLibrary();
    toast('Logged in – library synced ✓');
  } catch (err) {
    $('#accErr').textContent = err.message.includes('fetch') ? 'Server not reachable – is node server.js running?' : err.message;
  }
};
$('#creditsBtn').onclick = () => $('#creditsModal').classList.remove('hidden');
$('#creditsClose').onclick = () => $('#creditsModal').classList.add('hidden');
$('#accSync').onclick = () => sync.syncNow().then(renderUsage);
const fmtBytes = (b) => (b == null ? '?' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
async function renderUsage() {
  if (!sync.getAccount()) return;
  try {
    const u = await sync.usage();
    $('#accUsage').innerHTML = `Konto: <b>${u.songs}</b> Songs · <b>${u.banks}</b> Sound-Bibliotheken/Presets · <b>${fmtBytes(u.totalBytes)}</b> belegt · ${fmtBytes(u.free)} frei`;
    $('#accAuto').checked = !!u.autoBackup?.enabled;
    const a = u.autoBackup || {};
    $('#accAutoInfo').textContent = a.enabled
      ? (a.error ? '⚠ ' + a.error : a.last ? `Letzte Sicherung: ${new Date(a.last).toLocaleString()} · ${fmtBytes(a.bytes)} · ${a.file}` : 'Wird nach der nächsten Änderung erstellt')
      : `Aus – Sicherungsdatei würde in ${u.backupDir} liegen (für Google-Drive-/PC-Sync-Apps erreichbar).`;
    $('#accBackup').href = sync.backupUrl();
  } catch (e) { $('#accUsage').textContent = e.message; }
}
$('#accAuto').onchange = async (e) => {
  try { await sync.setAutoBackup(e.target.checked); toast(e.target.checked ? 'Automatische Sicherung aktiv' : 'Automatische Sicherung aus'); }
  catch (err) { toast(err.message, 5000); e.target.checked = !e.target.checked; }
  renderUsage();
};
$('#accRestore').onclick = () => $('#accRestoreFile').click();
$('#accRestoreFile').onchange = async (e) => {
  let f;
  try { [f] = await snapshotFiles([...e.target.files].slice(0, 1)); } catch (err) { return toast('Datei konnte nicht gelesen werden: ' + err.message, 6000); }
  finally { e.target.value = ''; }
  if (!f || !confirm(`Sicherung „${f.name}“ in dein Konto übernehmen? Neuere Daten im Konto bleiben erhalten.`)) return;
  try {
    busy('Stelle Sicherung wieder her …');
    const r = await sync.restoreBackup(f);
    unbusy();
    toast(`Wiederhergestellt: ${r.songs} Songs, ${r.banks} Bibliotheken, ${r.blobs} Dateien`, 5000, 'ic-trophy');
    renderLibrary();
    renderUsage();
  } catch (err) { unbusy(); toast(err.message, 6000); }
};
$('#accLogout').onclick = async () => { await sync.logout(); renderAccount(); };

sync.registerProfile({
  get: () => { const { micActive, ...s } = settings; return { settings: s, chat: ai.history }; },
  apply: (p) => {
    if (p.settings) {
      Object.assign(settings, p.settings, { micActive: settings.micActive });
      saveSettings(true);
      piano.setVolume(settings.volume);
      if (currentPlayer) syncHud();
    }
    if (p.chat) { ai.setHistory(p.chat); if (!$('#view-create').classList.contains('hidden')) renderChat(); }
  },
});
document.addEventListener('kf-profile', () => sync.profileChanged());

// installable app + offline: register the service worker (https or localhost only)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}

// ---------------- boot ----------------
(async () => {
  const firstRun = await seedIfEmpty();
  const CLOUD = sync.backendKind() === 'cloud';
  if (CLOUD) {
    document.documentElement.classList.add('cloud');
    $('#accUser').placeholder = 'E-Mail-Adresse';
    $('#accUser').type = 'email';
    $('#accUser').autocomplete = 'email';
    renderAccount();
    sync.syncNow();
  }
  if (STATIC) {
    for (const v of ['muscriptor', 'transkun']) { const o = $(`#optModel option[value=${v}]`); o.disabled = true; o.textContent += ' – nur lokale App'; }
    $('#optDemucs').parentElement.firstChild.textContent = 'Gesang & Drums entfernen (Demucs im Browser, einmalig ~181 MB) ';
    $('#askInput').placeholder = 'Eingebauten Song suchen – oder Audio mit + hochladen';
  } else {
    renderAccount();
    sync.syncNow();
  }
  (STATIC ? Promise.reject() : fetch('/api/caps')).then((r) => r.json()).then((caps) => {
    const d = $('#optDemucs');
    // without server Demucs the browser version is used automatically
    if (!caps.demucs) d.parentElement.firstChild.textContent = 'Gesang & Drums entfernen (Demucs im Browser, einmalig ~181 MB) ';
    const ms = $('#optModel option[value=muscriptor]');
    if (!caps.muscriptor) { ms.disabled = true; ms.textContent += ' – not installed'; }
    const tk = $('#optModel option[value=transkun]');
    if (!caps.transkun) { tk.disabled = true; tk.textContent += ' – nicht installiert (~/install-transkun.sh)'; }
  }).catch(() => {});
  if (!location.hash) location.hash = firstRun ? '#/new' : '#/library'; // fires hashchange → route()
  else route();
})();
