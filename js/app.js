// js/app.js — Mitt Bondøya
(function(){
"use strict";

const el = id => document.getElementById(id);

let mapCtx = null;
let funnCache = [];
let speciesCache = [];
let artskartCache = []; // [{art, taxonId, lat, lon, dato}, ...] fra data/artskart-bondoya.json
let activeFilter = 'alle';
let pendingImageBlob = null;
let pendingPosition = null; // {lat, lon}
let pendingPositionKilde = null; // 'gps' | 'exif' | 'manuell' — vises i UI, se renderRegisterPanel
let pendingTimestamp = null; // Date, forhåndsutfylt fra EXIF ved etterregistrering, alltid brukerjusterbar
let pendingKiResultat = null;

// ---------- oppstart ----------

document.addEventListener('DOMContentLoaded', async () => {
  mapCtx = initMap();
  window.addEventListener('funn:selected', e => openDetail(e.detail));

  await loadSpecies();
  await refreshFromRepo();

  wireSetupPanel();
  wireListPanel();
  wireRegisterFlow();
  wireSheetDismiss();

  window.addEventListener('online', () => { updateSyncPill(); trySync(); });
  window.addEventListener('offline', updateSyncPill);
  updateSyncPill();
  trySync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW-registrering feilet', err));
  }
});

async function loadSpecies(){
  try {
    const res = await fetch('data/species.json');
    speciesCache = await res.json();
  } catch (e) {
    console.warn('Kunne ikke laste species.json', e);
    speciesCache = [];
  }
}

async function refreshFromRepo(){
  if (!window.GhStore.isConfigured()) {
    funnCache = window.GhStore.loadLocal('funn') || [];
    renderFinds(mapCtx.findsLayer, funnCache, activeFilter);
    renderList();
    return;
  }
  try {
    const [{ data: funn }, artskart] = await Promise.all([
      window.GhStore.loadFile('data/funn.json'),
      window.GhStore.loadFile('data/artskart-bondoya.json').catch(() => ({ data: null }))
    ]);
    funnCache = funn || [];
    artskartCache = (artskart && artskart.data) || [];
    window.GhStore.saveLocal('funn', funnCache);
    renderFinds(mapCtx.findsLayer, funnCache, activeFilter);
    renderList();
  } catch (e) {
    showToast('Kunne ikke hente funn: ' + e.message);
  }
}

// ---------- setup-panel ----------

const MAPBOX_TOKEN_KEY = 'mittbondoya-mapbox-token';

function wireSetupPanel(){
  const cfg = window.GhStore.getConfig();
  if (cfg) {
    el('ghOwner').value = cfg.owner;
    el('ghRepo').value = cfg.repo;
    el('ghToken').value = cfg.token;
  }
  el('kiProxyUrl').value = window.KiClient.getProxyUrl();
  el('kiSharedSecret').value = window.KiClient.getSharedSecret();
  el('mapboxToken').value = localStorage.getItem(MAPBOX_TOKEN_KEY) || '';

  el('setupToggle').addEventListener('click', () => toggleSheet('setupPanel'));

  el('ghConnectBtn').addEventListener('click', async () => {
    const owner = el('ghOwner').value.trim();
    const repo = el('ghRepo').value.trim();
    const token = el('ghToken').value.trim();
    const kiUrl = el('kiProxyUrl').value.trim();
    const kiSecret = el('kiSharedSecret').value.trim();
    const mapboxToken = el('mapboxToken').value.trim();
    if (!owner || !repo || !token) {
      el('ghNote').textContent = 'Fyll ut eier, repo og token.';
      return;
    }
    el('ghNote').textContent = 'Kobler til …';
    try {
      const branch = await window.GhStore.detectDefaultBranch(owner, repo, token);
      window.GhStore.setConfig({ owner, repo, token, branch });
      if (kiUrl) window.KiClient.setProxyUrl(kiUrl);
      if (kiSecret) window.KiClient.setSharedSecret(kiSecret);
      const mapboxChanged = mapboxToken && mapboxToken !== (localStorage.getItem(MAPBOX_TOKEN_KEY) || '');
      if (mapboxToken) localStorage.setItem(MAPBOX_TOKEN_KEY, mapboxToken);
      el('ghNote').textContent = `Tilkoblet (branch: ${branch}).`;
      await refreshFromRepo();
      toggleSheet('setupPanel', false);
      if (mapboxChanged) { showToast('Mapbox-token lagret — laster kartet på nytt …'); setTimeout(() => location.reload(), 800); }
    } catch (e) {
      el('ghNote').textContent = 'Feil: ' + e.message;
    }
  });

  el('ghDisconnectBtn').addEventListener('click', () => {
    window.GhStore.clearConfig();
    el('ghToken').value = '';
    el('ghNote').textContent = 'Koblet fra. Funn vises kun lokalt nå.';
    refreshFromRepo();
  });
}

function updateSyncPill(){
  const pill = el('syncStatus');
  if (!window.GhStore.isConfigured()) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.textContent = navigator.onLine ? '🟢 Tilkoblet' : '🟡 Offline';
}

async function trySync(){
  const result = await window.OfflineQueue.syncQueue((item, status) => {
    if (status === 'ferdig') showToast('Funn synkronisert ✓');
  });
  if (result.synket > 0) await refreshFromRepo();
  renderQueueBadge();
}

async function renderQueueBadge(){
  const items = await window.OfflineQueue.queueAll();
  const pill = el('syncStatus');
  if (items.length > 0 && window.GhStore.isConfigured()) {
    pill.hidden = false;
    pill.textContent = `⏳ ${items.length} venter på synk`;
  }
}

// ---------- artsforslag (stedsforankret plausibilitet) ----------

function buildSpeciesHintList(){
  // Teller Artskart-treff per art (allerede filtrert til nær Bondøya av
  // fetch-artskart-workflowen), og bruker det som plausibilitets-vekt.
  const counts = {};
  for (const obs of artskartCache) {
    counts[obs.art] = (counts[obs.art] || 0) + 1;
  }
  return speciesCache
    .map(s => ({
      norsk: s.norsk, latinsk: s.latinsk, artstype: s.artstype,
      plausibilitet: counts[s.norsk.toLowerCase()] || 0
    }))
    .sort((a, b) => b.plausibilitet - a.plausibilitet);
}

function nearbyCountFor(norskNavn){
  return artskartCache.filter(o => (o.art || '').toLowerCase() === norskNavn.toLowerCase()).length;
}

// ---------- registreringsflyt ----------

function wireRegisterFlow(){
  el('fabRegister').addEventListener('click', () => startRegistration(false));
  el('fabGallery').addEventListener('click', () => startRegistration(true));
  el('cameraInput').addEventListener('change', onImageCaptured);
  el('galleryInput').addEventListener('change', onImageCaptured);
}

// fraGalleri=false: kamera i felt — anta at brukeren står der bildet tas,
// hent GPS-posisjon automatisk med det samme.
// fraGalleri=true: etterregistrering av et bilde tatt tidligere (kamerarull)
// — nåværende GPS-posisjon ville vært feil, så brukeren MÅ velge posisjon i
// kartet i stedet (se pickPositionOnMap/renderRegisterPanel).
function startRegistration(fraGalleri){
  pendingImageBlob = null;
  pendingPosition = null;
  pendingPositionKilde = null;
  pendingTimestamp = null;
  pendingKiResultat = null;
  if (!fraGalleri && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { pendingPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude }; pendingPositionKilde = 'gps'; },
      () => { /* la brukeren velge i kart i stedet, se posisjonsvelgeren under */ },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }
  const input = fraGalleri ? el('galleryInput') : el('cameraInput');
  input.value = '';
  input.click();
}

function pickPositionOnMap(){
  toggleSheet('registerPanel', false);
  showToast('Trykk i kartet der bildet ble tatt');
  mapCtx.map.once('click', (e) => {
    pendingPosition = { lat: e.latlng.lat, lon: e.latlng.lng };
    pendingPositionKilde = 'manuell';
    toggleSheet('registerPanel', true);
    renderRegisterPanel({ scanning: false });
  });
}

// Leser EXIF GPS/dato fra ORIGINALFILEN (må skje FØR compressImage — canvas-
// re-enkoding i compressImage fjerner all EXIF-metadata). Kun relevant for
// bilder valgt fra kamerarullen (etterregistrering) — et fersk kamerabilde
// har allerede en pålitelig, live GPS-posisjon fra selve enheten, se
// startRegistration. exifr.gps()/parse() feiler stille (returnerer
// undefined/kaster) for bilder uten EXIF (f.eks. skjermdump, redigert bilde)
// — helt normalt, appen faller da tilbake til manuelt valgt posisjon/dato.
async function extractExif(file){
  if (!window.exifr) return {};
  let gps, dato;
  try { gps = await window.exifr.gps(file); } catch (e) { /* ingen GPS-data i bildet */ }
  try {
    const parsed = await window.exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    dato = parsed && (parsed.DateTimeOriginal || parsed.CreateDate);
  } catch (e) { /* ingen dato-data i bildet */ }
  return { gps, dato };
}

async function onImageCaptured(e){
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const fraGalleri = e.target.id === 'galleryInput';

  if (fraGalleri) {
    const { gps, dato } = await extractExif(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      pendingPosition = { lat: gps.latitude, lon: gps.longitude };
      pendingPositionKilde = 'exif';
    }
    if (dato instanceof Date && !isNaN(dato)) pendingTimestamp = dato;
  }

  pendingImageBlob = await compressImage(file);
  renderRegisterPanel({ scanning: true });
  toggleSheet('registerPanel', true);

  if (window.KiClient.isConfigured()) {
    try {
      const hint = buildSpeciesHintList();
      pendingKiResultat = await window.KiClient.gjenkjenn(pendingImageBlob, hint);
    } catch (err) {
      console.warn('KI-gjenkjenning feilet', err);
      pendingKiResultat = null;
    }
  }
  renderRegisterPanel({ scanning: false });
}

// Skalerer ned og komprimerer bildet client-side før opplasting (maks 1600px
// lengste side, JPEG q~0.8) — holder data-repoets vekst i sjakk over tid, se
// konsept.md "Etter MVP: kritisk arkitekturvurdering".
function compressImage(file){
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxSide = 1600;
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        const scale = maxSide / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => { URL.revokeObjectURL(url); resolve(blob); }, 'image/jpeg', 0.8);
    };
    img.src = url;
  });
}

function renderRegisterPanel(state){
  const c = el('registerContent');
  const previewUrl = pendingImageBlob ? URL.createObjectURL(pendingImageBlob) : null;

  if (state.scanning) {
    c.innerHTML = `
      <div class="scanWrap">
        <img src="${previewUrl}" class="scanImg" alt="">
        <div class="scanLine"></div>
      </div>
      <p class="hint">KI analyserer bildet …</p>`;
    return;
  }

  const beste = pendingKiResultat && pendingKiResultat.beste;
  const autoVelg = pendingKiResultat && pendingKiResultat.autoVelg;
  const alternativer = (pendingKiResultat && pendingKiResultat.alternativer) || [];

  let kiHtml = '';
  if (beste && autoVelg) {
    kiHtml = `
      <div class="kiCard kiCardAuto">
        <strong>${escapeHtml(beste.art.norsk)}</strong>
        <span class="konfidensBadge">${Math.round(beste.konfidens*100)} %</span>
        <p class="hint">KI er ganske sikker — bekreft eller velg en annen art under.</p>
      </div>`;
  } else if (alternativer.length) {
    kiHtml = `
      <p class="hint">KI er usikker — velg riktig alternativ:</p>
      <div class="candidateCards">
        ${alternativer.map((a, i) => `
          <button class="candidateCard" data-idx="${i}">
            <strong>${escapeHtml(a.norsk)}</strong>
            <span class="konfidensBadge">${Math.round((a.konfidens||0)*100)} %</span>
          </button>`).join('')}
      </div>`;
  } else {
    kiHtml = `<p class="hint">Ingen KI-forslag (proxy ikke konfigurert eller ingen treff). Velg art manuelt under.</p>`;
  }

  const kildeLabel = { gps: '(GPS)', exif: '(fra bildet)', manuell: '(valgt manuelt)' }[pendingPositionKilde] || '';
  const posHtml = pendingPosition
    ? `📍 ${pendingPosition.lat.toFixed(5)}, ${pendingPosition.lon.toFixed(5)} <span class="hint">${kildeLabel}</span> <button id="changePosBtn" class="linkBtn">endre</button>`
    : `<button id="pickPosBtn" class="secondaryBtn">📍 Velg posisjon i kart</button>`;

  const datoValue = toDatetimeLocalValue(pendingTimestamp || new Date());

  c.innerHTML = `
    <img src="${previewUrl}" class="previewImg" alt="">
    ${kiHtml}
    <div id="posStatus" class="posStatus">${posHtml}</div>
    <label for="findDato">Tidspunkt</label>
    <input id="findDato" type="datetime-local" value="${datoValue}">
    <label for="speciesSearch">Søk art manuelt</label>
    <input id="speciesSearch" type="text" placeholder="f.eks. havørn" autocomplete="off">
    <div id="speciesResults" class="speciesResults"></div>
    <div id="selectedSpecies" class="selectedSpecies"></div>
    <div class="sheetActions">
      <button id="saveFindBtn" class="primaryBtn" disabled>Lagre funn</button>
      <button id="cancelFindBtn" class="secondaryBtn">Avbryt</button>
    </div>`;

  const pickBtn = el('pickPosBtn') || el('changePosBtn');
  if (pickBtn) pickBtn.addEventListener('click', pickPositionOnMap);
  el('findDato').addEventListener('change', (ev) => {
    const d = new Date(ev.target.value);
    if (!isNaN(d)) pendingTimestamp = d;
  });

  let valgtArt = (beste && autoVelg) ? { norsk: beste.art.norsk, latinsk: beste.art.latinsk, artstype: beste.artstype } : null;
  updateSaveButton();

  function setValgt(art){
    valgtArt = art;
    el('selectedSpecies').innerHTML = art
      ? `Valgt: <strong>${escapeHtml(art.norsk)}</strong> <em>${escapeHtml(art.latinsk||'')}</em>`
      : '';
    updateSaveButton();
  }
  function updateSaveButton(){ el('saveFindBtn').disabled = !valgtArt || !pendingPosition; }

  c.querySelectorAll('.candidateCard').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = alternativer[Number(btn.dataset.idx)];
      setValgt({ norsk: a.norsk, latinsk: a.latinsk, artstype: a.artstype });
    });
  });

  el('speciesSearch').addEventListener('input', (ev) => {
    const term = ev.target.value.trim().toLowerCase();
    const results = term.length < 2 ? [] : speciesCache.filter(s =>
      s.norsk.toLowerCase().includes(term) || s.latinsk.toLowerCase().includes(term)
    ).slice(0, 6);
    el('speciesResults').innerHTML = results.map((s, i) =>
      `<button class="speciesResult" data-i="${i}">${escapeHtml(s.norsk)} <em>${escapeHtml(s.latinsk)}</em></button>`
    ).join('');
    el('speciesResults').querySelectorAll('.speciesResult').forEach((btn, i) => {
      btn.addEventListener('click', () => { setValgt(results[i]); el('speciesResults').innerHTML=''; el('speciesSearch').value = results[i].norsk; });
    });
  });

  el('cancelFindBtn').addEventListener('click', () => toggleSheet('registerPanel', false));
  el('saveFindBtn').addEventListener('click', () => saveFind(valgtArt));

  if (beste && autoVelg) setValgt({ norsk: beste.art.norsk, latinsk: beste.art.latinsk, artstype: beste.artstype });
}

async function saveFind(art){
  const pos = pendingPosition; // sikkerhetsnett — knappen er disablet uten posisjon, se updateSaveButton
  if (!pos) { showToast('Velg posisjon i kartet først.'); return; }

  const entry = {
    art, artstype: art.artstype, lat: pos.lat, lon: pos.lon,
    tidspunkt: (pendingTimestamp || new Date()).toISOString(), imageBlob: pendingImageBlob,
    registrertAv: ''
  };

  toggleSheet('registerPanel', false);

  if (navigator.onLine && window.GhStore.isConfigured()) {
    try {
      const imagePath = `images/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      await window.GhStore.saveImage(imagePath, pendingImageBlob);
      await window.GhStore.saveWithRetry('data/funn.json', (data) => {
        const funn = data || [];
        funn.push({
          id: imagePath, art: entry.art, artstype: entry.artstype,
          lat: entry.lat, lon: entry.lon, tidspunkt: entry.tidspunkt,
          bilde: imagePath, registrertAv: entry.registrertAv,
          kiKonfidens: pendingKiResultat && pendingKiResultat.beste ? pendingKiResultat.beste.konfidens : 0,
          kiAlternativer: (pendingKiResultat && pendingKiResultat.alternativer) || []
        });
        return funn;
      });
      showToast('Funn registrert ✓');
      await refreshFromRepo();
      return;
    } catch (e) {
      console.warn('Direkte lagring feilet, legger i offline-kø i stedet', e);
    }
  }

  await window.OfflineQueue.queueAdd(entry);
  showToast('Ingen nett — funnet er lagret og synkes automatisk senere.');
  renderQueueBadge();
}

// ---------- liste ----------

function wireListPanel(){
  el('listToggle').addEventListener('click', () => { renderList(); toggleSheet('listPanel'); });
  const artstyper = ['alle', 'fugl', 'sjøpattedyr', 'alge', 'blomst', 'annet'];
  el('filterRow').innerHTML = artstyper.map(t =>
    `<button class="filterChip${t===activeFilter?' active':''}" data-t="${t}">${t}</button>`
  ).join('');
  el('filterRow').querySelectorAll('.filterChip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.t;
      el('filterRow').querySelectorAll('.filterChip').forEach(b => b.classList.toggle('active', b === btn));
      renderFinds(mapCtx.findsLayer, funnCache, activeFilter);
      renderList();
    });
  });
}

function renderList(){
  const list = funnCache.filter(f => activeFilter === 'alle' || f.artstype === activeFilter);
  el('findList').innerHTML = list.map(f => `
    <button class="findRow" data-id="${f.id}">
      <strong>${escapeHtml(f.art?.norsk || 'Ukjent')}</strong>
      <span class="hint">${new Date(f.tidspunkt).toLocaleDateString('no-NO')}</span>
    </button>`).join('') || '<p class="hint">Ingen registrerte funn ennå.</p>';
  el('findList').querySelectorAll('.findRow').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = funnCache.find(x => x.id === btn.dataset.id);
      if (f) { toggleSheet('listPanel', false); panToFind(mapCtx.map, f); openDetail(f); }
    });
  });
}

// ---------- artsdetaljer ----------

function openDetail(funn){
  const s = speciesCache.find(sp => sp.latinsk === funn.art?.latinsk) || {};
  const count = nearbyCountFor(funn.art?.norsk || '');
  el('detailContent').innerHTML = `
    ${funn.bilde ? '' : ''}
    <h2>${escapeHtml(funn.art?.norsk || 'Ukjent art')}</h2>
    <p><em>${escapeHtml(funn.art?.latinsk || s.latinsk || '')}</em></p>
    ${s.beskrivelse ? `<p>${escapeHtml(s.beskrivelse)}</p>` : ''}
    ${count ? `<p class="hint">Registrert ${count} ganger i nærheten før (Artskart).</p>` : ''}
    <p>Registrert: ${new Date(funn.tidspunkt).toLocaleString('no-NO')}</p>
    ${s.artskartUrl ? `<a href="${s.artskartUrl}" target="_blank" rel="noopener">Se på Artsdatabanken →</a>` : ''}`;
  toggleSheet('detailPanel', true);
}

// ---------- sheets / UI-hjelpere ----------

function toggleSheet(id, force){
  const sheet = el(id);
  const show = force !== undefined ? force : sheet.hidden;
  ['setupPanel','listPanel','detailPanel','registerPanel'].forEach(other => {
    if (other !== id) el(other).hidden = true;
  });
  sheet.hidden = !show;
}

function wireSheetDismiss(){
  document.querySelectorAll('.sheetHandle').forEach(handle => {
    handle.addEventListener('click', () => { handle.parentElement.hidden = true; });
  });
}

let toastTimer = null;
function showToast(msg){
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Formaterer en Date til verdien <input type="datetime-local"> forventer
// ("YYYY-MM-DDTHH:mm"), i LOKAL tid (ikke UTC — new Date().toISOString()
// ville vist feil klokkeslett i inputfeltet for de fleste norske brukere).
function toDatetimeLocalValue(date){
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

})();
