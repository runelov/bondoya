// js/app.js — Bondøya
(function(){
"use strict";

const APP_VERSION = '0.4.0';
const APP_BUILD_DATE = '2026-07-12';

const el = id => document.getElementById(id);

let mapCtx = null;
let funnCache = [];
let speciesCache = [];
let artskartCache = []; // [{art, taxonId, lat, lon, dato}, ...] fra data/artskart-bondoya.json
let activeFilter = 'alle';
let activeVisning = 'alle'; // 'alle' | 'mine' — se wireListPanel
let brukerCache = null; // {epost, kortnavn, rolle} eller null — satt av sjekkSesjon()
let pendingImageBlob = null;
let pendingPosition = null; // {lat, lon}
let pendingPositionKilde = null; // 'gps' | 'exif' | 'manuell' — vises i UI, se renderRegisterPanel
let pendingTimestamp = null; // Date, forhåndsutfylt fra EXIF ved etterregistrering, alltid brukerjusterbar
let pendingKiResultat = null;
let pendingArt = null; // { norsk, latinsk, artstype } — løftet ut av renderRegisterPanel sin
// lokale closure-variabel, ellers nullstilles et manuelt artsvalg hver gang
// panelet re-rendres (f.eks. etter at posisjon velges i kart), se pickPositionOnMap.

// ---------- oppstart ----------

document.addEventListener('DOMContentLoaded', async () => {
  mapCtx = await initMapNarKlar();
  window.addEventListener('funn:selected', e => openDetail(e.detail));

  await loadSpecies();
  await sjekkSesjon();
  await refreshFromRepo();

  wireAccountPanel();
  wireAdminPanel();
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

// #map-containeren kan i sjeldne tilfeller ha 0x0 størrelse akkurat idet
// denne kjører (f.eks. viewport/embedding ikke ferdig lagt ut ennå) —
// Leaflet sin fitBounds() kaster da "Invalid LatLng", og uten denne
// beskyttelsen stopper det HELE oppstartskjeden under (innlogging,
// funnliste, registreringsflyt ville aldri blitt wiret opp). Ett forsøk
// til på neste animasjonsframe er nok til at containeren har fått en
// reell størrelse.
function initMapNarKlar(){
  return new Promise((resolve) => {
    try {
      resolve(initMap());
    } catch (e) {
      // setTimeout (ikke requestAnimationFrame) bevisst — rAF suspenderes i
      // bakgrunnsfaner/skjulte viewports og ville da aldri kjørt, og latt
      // hele oppstartskjeden henge for alltid på denne await-en.
      console.warn('Kartinitialisering feilet, prøver på nytt om 100ms', e);
      setTimeout(() => {
        try {
          resolve(initMap());
        } catch (e2) {
          console.error('Kartinitialisering feilet igjen, fortsetter uten kart', e2);
          resolve(null);
        }
      }, 100);
    }
  });
}

async function loadSpecies(){
  try {
    const res = await fetch('data/species.json');
    speciesCache = await res.json();
  } catch (e) {
    console.warn('Kunne ikke laste species.json', e);
    speciesCache = [];
  }
}

// Feiler bevisst aldri (nettverksfeil → behandlet som "ikke innlogget") —
// resten av appens oppstart (kart, liste, registreringsflyt) må fortsette å
// wire seg opp selv om bondoya-api er utilgjengelig akkurat nå.
async function sjekkSesjon(){
  try {
    brukerCache = await window.ApiClient.meg();
  } catch (e) {
    console.warn('Kunne ikke sjekke innloggingsstatus', e);
    brukerCache = null;
  }
  renderAccountPanel();
  return brukerCache;
}

async function refreshFromRepo(){
  if (!brukerCache) {
    // Offentlig (uinnlogget) lag: live, redusert visning fra bondoya-api,
    // se konsept.md "Offentlig lag" og worker/api/src/routes/offentlig.js.
    try {
      funnCache = await window.ApiClient.hentOffentligeFunn();
    } catch (e) {
      showToast('Kunne ikke hente funn: ' + e.message);
    }
    renderFindsPaKart();
    renderList();
    return;
  }
  try {
    funnCache = await window.ApiClient.hentFunn();
    window.GhStore.saveLocal('funn', funnCache);
  } catch (e) {
    showToast('Kunne ikke hente funn: ' + e.message);
    return;
  }
  // Artskart-berikelse er fortsatt et eget, valgfritt GitHub-basert
  // datakilde (se setupPanel) — frikoblet fra selve funn-lastingen over,
  // uendret siden MVP.
  if (window.GhStore.isConfigured()) {
    try {
      const { data } = await window.GhStore.loadFile('data/artskart-bondoya.json');
      artskartCache = data || [];
    } catch {
      artskartCache = [];
    }
  }
  renderFindsPaKart();
  renderList();
}

// ---------- konto / innlogging ----------

function wireAccountPanel(){
  el('accountToggle').addEventListener('click', () => toggleSheet('accountPanel'));

  el('loginSendBtn').addEventListener('click', async () => {
    const epost = el('loginEpost').value.trim();
    if (!epost) { el('loginNote').textContent = 'Skriv inn e-posten din.'; return; }
    const turnstileToken = (window.turnstile && window.turnstile.getResponse()) || '';
    el('loginNote').textContent = 'Sender …';
    try {
      const res = await window.ApiClient.beOmLenke(epost, turnstileToken);
      el('loginNote').textContent = res.melding;
    } catch (e) {
      el('loginNote').textContent = 'Feil: ' + e.message;
    } finally {
      if (window.turnstile && window.turnstile.reset) window.turnstile.reset();
    }
  });

  el('loggUtBtn').addEventListener('click', async () => {
    await window.ApiClient.loggUt();
    brukerCache = null;
    renderAccountPanel();
    toggleSheet('accountPanel', false);
    showToast('Logget ut.');
    await refreshFromRepo();
  });

  renderAccountPanel();
}

function renderAccountPanel(){
  el('accountLoggedOut').hidden = !!brukerCache;
  el('accountLoggedInn').hidden = !brukerCache;
  if (brukerCache) el('accountKortnavn').textContent = brukerCache.kortnavn;
  // Kun kosmetisk — skjuler knappen for ikke-admins. Faktisk håndhevelse
  // skjer server-side (requireAdmin() på hvert admin-endepunkt), en
  // klientside-sjekk her er ingen sikkerhetsgrense i seg selv.
  el('adminToggle').hidden = !brukerCache || brukerCache.rolle !== 'admin';
  // Offentlig (uinnlogget) lag: ingen tilgang til registrering eller andre
  // "koster penger"-funksjoner, jf. konsept.md "Offentlig lag" — samme
  // kosmetisk-skjuling-prinsipp som adminToggle over, faktisk håndhevelse
  // skjer server-side (requireSession på POST /funn og GET /tiles/...).
  el('fabRegister').hidden = !brukerCache;
  el('fabGallery').hidden = !brukerCache;
  el('setupToggle').hidden = !brukerCache;
  if (mapCtx) mapCtx.settInnloggingsstatus(!!brukerCache);
}

// ---------- admin ----------

function wireAdminPanel(){
  el('adminToggle').addEventListener('click', async () => {
    toggleSheet('adminPanel');
    if (!el('adminPanel').hidden) await renderBrukerListe();
  });
}

async function renderBrukerListe(){
  const container = el('brukerList');
  container.innerHTML = '<p class="hint">Laster …</p>';
  let brukere;
  try {
    brukere = await window.ApiClient.hentBrukere();
  } catch (e) {
    container.innerHTML = `<p class="hint">Kunne ikke hente brukerliste: ${escapeHtml(e.message)}</p>`;
    return;
  }

  container.innerHTML = brukere.map((b) => {
    const slettetPermanent = !!b.slettet_tidspunkt;
    // /meg returnerer ikke bruker-id, kun epost/kortnavn/rolle — sammenlign på
    // epost i stedet (unikt, og uendret for innlogget admin siden
    // selv-sletting/-deaktivering avvises server-side uansett).
    const erSelv = brukerCache && b.epost === brukerCache.epost;
    return `
      <div class="findRow" style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
        <div><strong>${escapeHtml(b.kortnavn)}</strong> <span class="hint">${escapeHtml(b.rolle)}</span></div>
        <div class="hint">${escapeHtml(b.epost)} — ${slettetPermanent ? 'permanent slettet' : b.status}</div>
        <div class="sheetActions">
          <button class="secondaryBtn" data-handling="status" data-id="${b.id}" data-neste="${b.status === 'aktiv' ? 'deaktivert' : 'aktiv'}"
            ${slettetPermanent || erSelv ? 'disabled' : ''}>${b.status === 'aktiv' ? 'Deaktiver' : 'Reaktiver'}</button>
          <button class="secondaryBtn" data-handling="slett" data-id="${b.id}"
            ${slettetPermanent || erSelv ? 'disabled' : ''}>Slett permanent</button>
        </div>
      </div>`;
  }).join('') || '<p class="hint">Ingen brukere.</p>';

  container.querySelectorAll('[data-handling="status"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await window.ApiClient.settBrukerStatus(btn.dataset.id, btn.dataset.neste);
        await renderBrukerListe();
      } catch (e) {
        showToast('Feil: ' + e.message);
      }
    });
  });
  container.querySelectorAll('[data-handling="slett"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Slette denne brukeren permanent? E-posten fjernes for godt — kan ikke angres.')) return;
      try {
        await window.ApiClient.slettBrukerPermanent(btn.dataset.id);
        await renderBrukerListe();
      } catch (e) {
        showToast('Feil: ' + e.message);
      }
    });
  });
}

// ---------- setup-panel ----------

function wireSetupPanel(){
  el('appVersion').textContent = `Bondøya v${APP_VERSION} (${APP_BUILD_DATE})`;
  const cfg = window.GhStore.getConfig();
  if (cfg) {
    el('ghOwner').value = cfg.owner;
    el('ghRepo').value = cfg.repo;
    el('ghToken').value = cfg.token;
  }
  el('kiProxyUrl').value = window.KiClient.getProxyUrl();
  el('kiSharedSecret').value = window.KiClient.getSharedSecret();

  el('setupToggle').addEventListener('click', () => toggleSheet('setupPanel'));

  el('ghConnectBtn').addEventListener('click', async () => {
    const owner = el('ghOwner').value.trim();
    const repo = el('ghRepo').value.trim();
    const token = el('ghToken').value.trim();
    const kiUrl = el('kiProxyUrl').value.trim();
    const kiSecret = el('kiSharedSecret').value.trim();
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
      el('ghNote').textContent = `Tilkoblet (branch: ${branch}).`;
      await refreshFromRepo();
      toggleSheet('setupPanel', false);
    } catch (e) {
      el('ghNote').textContent = 'Feil: ' + e.message;
    }
  });

  el('ghDisconnectBtn').addEventListener('click', () => {
    window.GhStore.clearConfig();
    el('ghToken').value = '';
    el('ghNote').textContent = 'Koblet fra. Artskart-baserte artsforslag er nå avslått.';
    refreshFromRepo();
  });
}

function updateSyncPill(){
  const pill = el('syncStatus');
  if (!brukerCache) { pill.hidden = true; return; }
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
  if (items.length > 0 && brukerCache) {
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
  if (!brukerCache) {
    showToast('Logg inn for å registrere funn.');
    toggleSheet('accountPanel', true);
    return;
  }
  pendingImageBlob = null;
  pendingPosition = null;
  pendingPositionKilde = null;
  pendingTimestamp = null;
  pendingKiResultat = null;
  pendingArt = null;
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
  if (!mapCtx) { showToast('Kartet er ikke tilgjengelig akkurat nå.'); return; }
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
  try { gps = await window.exifr.gps(file); } catch (e) { console.debug('EXIF: ingen GPS-data', e); }
  try {
    // MERK: exifr sitt array-form for å plukke enkelttags (parse(file, [...]))
    // kastet en intern feil i "lite"-bygget her (Symbol.iterator-feil i
    // setupGlobalFilters) — full parse() uten valg er tregere, men stabil.
    const parsed = await window.exifr.parse(file);
    dato = parsed && (parsed.DateTimeOriginal || parsed.CreateDate);
  } catch (e) { console.debug('EXIF: ingen dato-data', e); }
  // Kun til feilsøking (åpne konsollen for å se om et bilde faktisk mangler
  // EXIF — vanlig for nedlastede/delte bilder som har gått via komprimering,
  // i motsetning til et fersk, uredigert bilde rett fra kameraet).
  console.debug('EXIF lest fra', file.name, { gps, dato });
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
      console.debug('KI-svar', pendingKiResultat);
    } catch (err) {
      console.warn('KI-gjenkjenning feilet', err);
      pendingKiResultat = null;
    }
  } else {
    console.debug('KI-proxy er ikke konfigurert (Innstillinger → KI-proxy URL) — hopper over gjenkjenning.');
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
    kiHtml = `<p class="hint">Fant ikke arten automatisk. Velg art manuelt under.</p>`;
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

  // pendingArt overlever re-rendering av panelet (f.eks. etter posisjonsvalg
  // i kart, se pickPositionOnMap) — kun sett KI sitt auto-forslag som
  // startverdi hvis brukeren ikke allerede har valgt noe selv.
  if (!pendingArt && beste && autoVelg) {
    pendingArt = { norsk: beste.art.norsk, latinsk: beste.art.latinsk, artstype: beste.artstype };
  }
  if (pendingArt) el('speciesSearch').value = pendingArt.norsk;
  updateSaveButton();
  renderSelectedSpecies();

  function setValgt(art){
    pendingArt = art;
    renderSelectedSpecies();
    updateSaveButton();
  }
  function renderSelectedSpecies(){
    el('selectedSpecies').innerHTML = pendingArt
      ? `Valgt: <strong>${escapeHtml(pendingArt.norsk)}</strong> <em>${escapeHtml(pendingArt.latinsk||'')}</em>`
      : '';
  }
  function updateSaveButton(){ el('saveFindBtn').disabled = !pendingArt || !pendingPosition; }

  c.querySelectorAll('.candidateCard').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = alternativer[Number(btn.dataset.idx)];
      setValgt({ norsk: a.norsk, latinsk: a.latinsk, artstype: a.artstype });
    });
  });

  el('speciesSearch').addEventListener('input', (ev) => {
    const rawTerm = ev.target.value.trim();
    const term = rawTerm.toLowerCase();
    const results = term.length < 2 ? [] : speciesCache.filter(s =>
      s.norsk.toLowerCase().includes(term) || s.latinsk.toLowerCase().includes(term)
    ).slice(0, 6);
    // Artslisten er en kuratert forventning, ikke en fasit — uventede funn
    // (som en elg som har svømt ut til øya) skal fortsatt kunne registreres.
    // Tilbyr derfor alltid "bruk som ny art" når søket ikke er et eksakt
    // treff, i tillegg til eventuelle nære forslag.
    const eksaktTreff = speciesCache.some(s => s.norsk.toLowerCase() === term);
    const visFritekst = term.length >= 2 && !eksaktTreff;

    el('speciesResults').innerHTML =
      results.map((s, i) => `<button class="speciesResult" data-i="${i}">${escapeHtml(s.norsk)} <em>${escapeHtml(s.latinsk)}</em></button>`).join('') +
      (visFritekst ? `<button id="freeTextSpeciesBtn" class="speciesResult speciesResultFritekst">➕ Bruk «${escapeHtml(rawTerm)}» (ikke i listen)</button>` : '');

    el('speciesResults').querySelectorAll('.speciesResult:not(.speciesResultFritekst)').forEach((btn, i) => {
      btn.addEventListener('click', () => { setValgt(results[i]); el('speciesResults').innerHTML=''; el('speciesSearch').value = results[i].norsk; });
    });
    if (visFritekst) {
      el('freeTextSpeciesBtn').addEventListener('click', () => {
        setValgt({ norsk: rawTerm, latinsk: '', artstype: 'annet' });
        el('speciesResults').innerHTML = '';
      });
    }
  });

  el('cancelFindBtn').addEventListener('click', () => toggleSheet('registerPanel', false));
  el('saveFindBtn').addEventListener('click', () => saveFind(pendingArt));
}

async function saveFind(art){
  const pos = pendingPosition; // sikkerhetsnett — knappen er disablet uten posisjon, se updateSaveButton
  if (!pos) { showToast('Velg posisjon i kartet først.'); return; }

  const entry = {
    art, artstype: art.artstype, lat: pos.lat, lon: pos.lon,
    tidspunkt: (pendingTimestamp || new Date()).toISOString(), imageBlob: pendingImageBlob,
    kiKonfidens: pendingKiResultat && pendingKiResultat.beste ? pendingKiResultat.beste.konfidens : 0,
    kiAlternativer: (pendingKiResultat && pendingKiResultat.alternativer) || []
  };

  toggleSheet('registerPanel', false);

  if (navigator.onLine && brukerCache) {
    try {
      await window.ApiClient.opprettFunn(entry);
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

  const visninger = ['alle', 'mine'];
  el('visningRow').innerHTML = visninger.map(v =>
    `<button class="filterChip${v===activeVisning?' active':''}" data-v="${v}">${v === 'mine' ? 'Mine funn' : 'Alle funn'}</button>`
  ).join('');
  el('visningRow').querySelectorAll('.filterChip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeVisning = btn.dataset.v;
      el('visningRow').querySelectorAll('.filterChip').forEach(b => b.classList.toggle('active', b === btn));
      renderFindsPaKart();
      renderList();
    });
  });

  const artstyper = ['alle', 'fugl', 'sjøpattedyr', 'pattedyr', 'plante', 'alge', 'annet'];
  el('filterRow').innerHTML = artstyper.map(t =>
    `<button class="filterChip${t===activeFilter?' active':''}" data-t="${t}">${t}</button>`
  ).join('');
  el('filterRow').querySelectorAll('.filterChip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.t;
      el('filterRow').querySelectorAll('.filterChip').forEach(b => b.classList.toggle('active', b === btn));
      renderFindsPaKart();
      renderList();
    });
  });
}

function synligeFunn(){
  return funnCache.filter(f =>
    (activeFilter === 'alle' || f.artstype === activeFilter) &&
    (activeVisning === 'alle' || f.erEgenRegistrering)
  );
}

// mapCtx kan være null i det (svært sjeldne) tilfellet kartinitialisering
// feilet permanent, se initMapNarKlar() — resten av appen (innlogging,
// liste, registrering) skal likevel fungere, bare uten kartvisning.
function renderFindsPaKart(){
  if (mapCtx) renderFinds(mapCtx.findsLayer, synligeFunn(), 'alle');
}

function renderList(){
  const list = synligeFunn();
  el('findList').innerHTML = list.map(f => `
    <button class="findRow" data-id="${f.id}">
      <strong>${escapeHtml(f.art?.norsk || 'Ukjent')}</strong>
      <span class="hint">${new Date(f.tidspunkt).toLocaleDateString('no-NO')}${f.registrertAv ? ' · ' + escapeHtml(f.registrertAv) : ''}</span>
    </button>`).join('') || '<p class="hint">Ingen registrerte funn ennå.</p>';
  el('findList').querySelectorAll('.findRow').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = funnCache.find(x => String(x.id) === btn.dataset.id);
      if (f) { toggleSheet('listPanel', false); if (mapCtx) panToFind(mapCtx.map, f); openDetail(f); }
    });
  });
}

// ---------- artsdetaljer ----------

// Bildet vises direkte via <img src>, ikke fetch+blob+objectURL — sesjons-
// cookien sendes automatisk (samme site, se api-client.js sin bildeUrl()).
async function openDetail(funn){
  const s = speciesCache.find(sp => sp.latinsk === funn.art?.latinsk) || {};
  const count = nearbyCountFor(funn.art?.norsk || '');

  const bildeHtml = funn.bildeUrl
    ? `<img src="${window.ApiClient.bildeUrl(funn.id)}" class="previewImg" alt="">`
    : '';

  el('detailContent').innerHTML = `
    ${bildeHtml}
    <h2>${escapeHtml(funn.art?.norsk || 'Ukjent art')}</h2>
    <p><em>${escapeHtml(funn.art?.latinsk || s.latinsk || '')}</em></p>
    ${rodlisteBadge(s.rodlisteNorge)}
    ${s.beskrivelse ? `<p>${escapeHtml(s.beskrivelse)}</p>` : ''}
    ${count ? `<p class="hint">Registrert ${count} ganger i nærheten før (Artskart).</p>` : ''}
    <p>Registrert: ${new Date(funn.tidspunkt).toLocaleString('no-NO')}${funn.registrertAv ? ' av ' + escapeHtml(funn.registrertAv) : ''}</p>
    ${s.artskartUrl ? `<a href="${s.artskartUrl}" target="_blank" rel="noopener">Se på Artsdatabanken →</a>` : ''}
    ${funn.erEgenRegistrering || funn.kanSlette ? `
      <div class="sheetActions">
        ${funn.erEgenRegistrering ? '<button id="redigerFunnBtn" class="secondaryBtn">Rediger</button>' : ''}
        ${funn.kanSlette ? '<button id="slettFunnBtn" class="secondaryBtn">Slett</button>' : ''}
      </div>
      <div id="redigerFunnForm" hidden></div>` : ''}`;
  toggleSheet('detailPanel', true);

  if (funn.erEgenRegistrering) el('redigerFunnBtn').addEventListener('click', () => renderRedigerFunnSkjema(funn));
  if (!funn.kanSlette) return;

  el('slettFunnBtn').addEventListener('click', async () => {
    if (!confirm(`Slette funnet «${funn.art?.norsk || 'Ukjent'}»? Dette kan ikke angres.`)) return;
    try {
      await window.ApiClient.slettFunn(funn.id);
      showToast('Funn slettet.');
      toggleSheet('detailPanel', false);
      await refreshFromRepo();
    } catch (e) {
      showToast('Kunne ikke slette: ' + e.message);
    }
  });
}

const REDIGERBARE_ARTSTYPER = ['fugl', 'sjøpattedyr', 'pattedyr', 'plante', 'alge', 'annet'];

// Setter tekstverdier via .value-egenskapen i stedet for å interpolere dem inn
// i value="..."-attributter i markup — et artsnavn kan være fri tekst (se
// fritekst-fallbacken i speciesSearch), og escapeHtml() gjør strengen trygg
// som HTML-INNHOLD, ikke som HTML-ATTRIBUTT (anførselstegn slipper fortsatt
// gjennom og ville brutt ut av value="..."). .value-tilordning unngår
// HTML-parsing av verdien helt.
function renderRedigerFunnSkjema(funn){
  const container = el('redigerFunnForm');
  container.hidden = false;
  container.innerHTML = `
    <label for="redigerArtNorsk">Art (norsk)</label>
    <input id="redigerArtNorsk" type="text">
    <label for="redigerArtLatinsk">Art (latinsk, valgfritt)</label>
    <input id="redigerArtLatinsk" type="text">
    <label for="redigerArtstype">Artstype</label>
    <select id="redigerArtstype">
      ${REDIGERBARE_ARTSTYPER.map(t => `<option value="${t}">${t}</option>`).join('')}
    </select>
    <label for="redigerLat">Breddegrad</label>
    <input id="redigerLat" type="number" step="any">
    <label for="redigerLon">Lengdegrad</label>
    <input id="redigerLon" type="number" step="any">
    <label for="redigerTidspunkt">Tidspunkt</label>
    <input id="redigerTidspunkt" type="datetime-local">
    <div class="sheetActions">
      <button id="lagreRedigertBtn" class="primaryBtn">Lagre</button>
      <button id="avbrytRedigertBtn" class="secondaryBtn">Avbryt</button>
    </div>
    <p id="redigerNote" class="note"></p>`;

  el('redigerArtNorsk').value = funn.art?.norsk || '';
  el('redigerArtLatinsk').value = funn.art?.latinsk || '';
  el('redigerArtstype').value = funn.artstype;
  el('redigerLat').value = funn.lat;
  el('redigerLon').value = funn.lon;
  el('redigerTidspunkt').value = toDatetimeLocalValue(new Date(funn.tidspunkt));

  el('avbrytRedigertBtn').addEventListener('click', () => { container.hidden = true; container.innerHTML = ''; });
  el('lagreRedigertBtn').addEventListener('click', async () => {
    const artNorsk = el('redigerArtNorsk').value.trim();
    if (!artNorsk) { el('redigerNote').textContent = 'Art (norsk navn) mangler.'; return; }
    const lat = parseFloat(el('redigerLat').value);
    const lon = parseFloat(el('redigerLon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { el('redigerNote').textContent = 'Ugyldig posisjon.'; return; }

    const felter = {
      art_norsk: artNorsk,
      art_latinsk: el('redigerArtLatinsk').value.trim(),
      art_taxon_id: funn.art?.taxonId,
      artstype: el('redigerArtstype').value,
      lat, lon,
      tidspunkt: new Date(el('redigerTidspunkt').value).toISOString()
    };
    el('redigerNote').textContent = 'Lagrer …';
    try {
      const oppdatert = await window.ApiClient.oppdaterFunn(funn.id, felter);
      showToast('Funn oppdatert ✓');
      await refreshFromRepo();
      openDetail(oppdatert);
    } catch (e) {
      el('redigerNote').textContent = 'Feil: ' + e.message;
    }
  });
}

// Norsk Rødliste 2021-kode -> lesbar norsk tekst + alvorlighetsklasse for
// styling. Kun NT/VU/EN/CR regnes som "bekymringsfull" andre steder i appen
// (se species.json sitt synligForPublic-felt, satt av en engangs-berikelse
// mot Artskart sitt taxon-API 2026-07-11).
const RODLISTE_LABELS = {
  CR: 'Kritisk truet', EN: 'Sterkt truet', VU: 'Sårbar', NT: 'Nær truet'
};
function rodlisteBadge(kode){
  const label = RODLISTE_LABELS[kode];
  if (!label) return '';
  return `<p class="rodlisteBadge">⚠ Rødlistet: ${escapeHtml(label)} (${escapeHtml(kode)}) — Norsk rødliste 2021</p>`;
}

// ---------- sheets / UI-hjelpere ----------

function toggleSheet(id, force){
  const sheet = el(id);
  const show = force !== undefined ? force : sheet.hidden;
  ['setupPanel','listPanel','detailPanel','registerPanel','accountPanel','adminPanel'].forEach(other => {
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
