// sw.js — minimal service worker, kun for PWA-installerbarhet + at app-skallet
// (HTML/CSS/JS/manifest/ikoner) laster selv uten nett. All ekte data (GitHub
// API, Mapbox-fliser, KI-proxy) går alltid rett til nettverket, uberørt.

// CACHE_NAME følger APP_VERSION (js/app.js) fra og med 0.9.26 — bump denne
// sammen med APP_VERSION og query-strengene under ved hver deploy, så en
// ny versjon alltid får en ren cache i stedet for å arve forrige sin.
const CACHE_NAME = 'bondoya-shell-v0.9.26';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css?v=0.9.26',
  './js/app.js?v=0.9.26',
  './js/github-store.js?v=0.9.26',
  './js/api-client.js?v=0.9.26',
  './js/offline-queue.js?v=0.9.26',
  './js/ki-client.js?v=0.9.26',
  './js/map.js?v=0.9.26',
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

  // Nettverk først, cache kun som offline-reserve — IKKE cache-først med
  // bakgrunnsoppdatering ("stale-while-revalidate"). Med cache-først ble
  // en allerede-cachet, EKTE nettleser alltid tjent den forrige versjonen
  // av f.eks. js/app.js umiddelbart, mens en fersk versjon kun ble hentet
  // i bakgrunnen for å oppdatere cachen til NESTE sidelasting — et helt
  // deploy alltid ett steg bak, uansett hvor mange ganger siden ble lastet
  // på nytt etter en ny utrulling (konkret observert 2026-07-16: en admin
  // så ikke en artsomtale-funksjon fra 0.9.14, ni deploys senere, fordi
  // nettleseren fortsatt kjørte en js/app.js cachet fra før den). Med
  // nettverk-først får en online bruker alltid siste versjon; cachen
  // brukes kun når selve nettverkskallet feiler (reelt offline), som var
  // hele den opprinnelige hensikten med denne service workeren.
  event.respondWith(
    fetch(event.request).then(res => {
      // .clone() MÅ skje synkront her, før res sendes videre — kloner vi
      // den først etter at caches.open() (asynkront) er ferdig, kan
      // responsens body allerede ha begynt å bli konsumert av siden selv,
      // og clone() feiler med "Response body is already used".
      if (res.ok) {
        const cacheCopy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, cacheCopy));
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});
