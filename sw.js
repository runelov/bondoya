// sw.js — minimal service worker, kun for PWA-installerbarhet + at app-skallet
// (HTML/CSS/JS/manifest/ikoner) laster selv uten nett. All ekte data (GitHub
// API, Mapbox-fliser, KI-proxy) går alltid rett til nettverket, uberørt.

const CACHE_NAME = 'bondoya-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/github-store.js',
  './js/offline-queue.js',
  './js/ki-client.js',
  './js/map.js',
  './data/species.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isShellRequest = isSameOrigin && event.request.method === 'GET';
  if (!isShellRequest) return; // la alt annet (API-kall, kartfliser) gå rett til nett

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        if (res.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
