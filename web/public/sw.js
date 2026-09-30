const CACHE = 'ferment-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); return res; }).catch(() => caches.match(event.request).then((r) => r ?? caches.match('/index.html'))));
});
