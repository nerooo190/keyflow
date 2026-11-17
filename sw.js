// Keyflow service worker: app works offline and starts fast.
//  • own files: network-first (always the newest version when online), cache as offline fallback
//  • CDN libraries / samples (jsDelivr, esm.sh, tonejs): cache-first (versioned URLs never change)
//  • never touches /api/*, Supabase or big AI model downloads (they have their own caches)
const VERSION = 'keyflow-v1';
const SHELL = ['./', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icon.svg', 'icons/app/icon-192.png', 'icons/app/icon-512.png',
  'js/app.js', 'js/player.js', 'js/audio.js', 'js/util.js', 'js/db.js', 'js/songs.js', 'js/input.js', 'js/lights.js', 'js/fingering.js',
  'js/difficulty.js', 'js/sync.js', 'js/soundlib.js', 'js/assistant.js', 'js/coach-prompt.js', 'js/cloud-backend.js', 'js/cloud-config.js',
  'js/dx7.js', 'js/fm-engine.js', 'js/fm-processor.js', 'js/sfz.js', 'js/sf-engine.js', 'js/midi.js', 'js/musicxml.js', 'js/transcribe.js', 'js/hpss.js'];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|esm\.sh|tonejs\.github\.io|fonts\.(googleapis|gstatic)\.com)\//;
const SKIP = /\/api\/|supabase\.co|huggingface\.co|\.gguf|\.onnx/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('keyflow-v') && k !== VERSION && k !== VERSION + '-cdn').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || SKIP.test(req.url)) return;
  const url = new URL(req.url);
  if (CDN.test(req.url)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION + '-cdn').then((c) => c.put(req, copy)); }
      return res;
    })));
  } else if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
  }
});
