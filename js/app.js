// js/app.js — Bondøya
(function(){
"use strict";

const APP_VERSION = '0.9.23';
const APP_BUILD_DATE = '2026-07-16';

// Speilbilde av ARTSTYPER i worker/api/src/lib/taxonomi.js — appen har
// ingen build-step som lar de to dele en fil, så listen må holdes i synk
// manuelt. Brukt av både artstype-filteret (med "alle" i tillegg) og
// redigeringsskjemaets dropdown.
const ARTSTYPER = [
  'fugl', 'sjøpattedyr', 'pattedyr', 'plante', 'alge', 'sopp', 'fisk',
  'bløtdyr', 'krepsdyr', 'insekt', 'edderkoppdyr', 'krypdyr', 'amfibium',
  'nesledyr', 'pigghud', 'leddorm', 'annet',
];

const el = id => document.getElementById(id);

let mapCtx = null;
let funnCache = [];
let speciesCache = [];
let artskartCache = []; // [{art, taxonId, lat, lon, dato}, ...] fra data/artskart-bondoya.json
let activeFilter = 'alle';
let activeVisning = 'alle'; // 'alle' | 'mine' — se wireListPanel
let activeSort = 'nyeste'; // se SORTERINGER/wireListPanel
let activeGroup = 'ingen'; // se GRUPPERINGER/wireListPanel
let kunUsikre = false; // admin-only filter, se wireListPanel
let brukerCache = null; // {epost, kortnavn, rolle} eller null — satt av sjekkSesjon()
let offentligFunnSynlig = null; // null = ukjent enda (fail-closed inntil kjent), ellers boolean — se refreshFromRepo
let adminInnstillingerCache = null; // {funnSynligForPublic} — kun lastet/relevant i adminPanel
let pendingImageBlob = null;
// Beskåret utsnitt sendt til KI i stedet for pendingImageBlob (se
// renderRegisterPanel sin cropping-state) — kun et gjenkjenningshjelpemiddel,
// ALDRI det som lagres på funnet (pendingImageBlob forblir uendret).
let pendingKiCropBlob = null;
let pendingPosition = null; // {lat, lon}
let pendingPositionKilde = null; // 'gps' | 'exif' | 'manuell' — vises i UI, se renderRegisterPanel
let pendingTimestamp = null; // Date, forhåndsutfylt fra EXIF ved etterregistrering, alltid brukerjusterbar
let pendingKiResultat = null;
let pendingArt = null; // { norsk, latinsk, artstype } — løftet ut av renderRegisterPanel sin
// lokale closure-variabel, ellers nullstilles et manuelt artsvalg hver gang
// panelet re-rendres (f.eks. etter at posisjon velges i kart), se pickPositionOnMap.
let inviterToken = null; // satt av haandterInvitasjonFraUrl() hvis ?inviter=... er gyldig
let artsbeskrivelseCache = new Map(); // taxonId -> {beskrivelse, kilde, wikipediaUrl}, unngår gjentatte oppslag i én sesjon
let apentFunnId = null; // se lastArtsbeskrivelse() — luker ut et sent svar for et funn som ikke lenger vises
let visSlettedeBrukere = false; // se renderBrukerListe() — permanent slettede skjules som standard

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
  wireInviterPanel();
  wireDashboardPanel();
  wireSheetDismiss();

  await haandterInvitasjonFraUrl();

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
    // Admin kan skru funnvisning for besøkende helt av (adminPanel) — sjekk
    // det lette flagg-endepunktet FØR vi i det hele tatt spør om funn-data,
    // slik at vi ikke henter rådata når visning er avslått. Selve sperren
    // håndheves uansett server-side (listFunnOffentlig), dette er bare for å
    // unngå unødig nettverkskall og for å style knapp/kart riktig.
    try {
      const innstillinger = await window.ApiClient.hentOffentligInnstillinger();
      offentligFunnSynlig = !!innstillinger.funnSynligForPublic;
    } catch (e) {
      offentligFunnSynlig = false; // fail-closed ved feil, se lib/innstillinger.js-resonnementet
    }
    renderAccountPanel(); // oppdaterer listToggle-synlighet nå som vi vet

    if (offentligFunnSynlig) {
      try {
        funnCache = await window.ApiClient.hentOffentligeFunn();
      } catch (e) {
        showToast('Kunne ikke hente funn: ' + e.message);
      }
    } else {
      funnCache = [];
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

// Turnstile sitt data-callback/data-expired-callback (index.html) — knappen
// starter disabled i markup, siden beOmLenke() uten gyldig token uansett
// bare feiler server-side; å holde den disabled til utfordringen er løst
// unngår at brukeren rekker å klikke før den er klar.
window.onTurnstileVerified = () => { el('loginSendBtn').disabled = false; };
window.onTurnstileExpired = () => { el('loginSendBtn').disabled = true; };

function wireAccountPanel(){
  el('accountToggle').addEventListener('click', async () => {
    toggleSheet('accountPanel');
    if (!el('accountPanel').hidden) await renderKontoSiderListe();
  });

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
      el('loginSendBtn').disabled = true;
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

let turnstileLastet = false;
// Lastes kun når innloggingsskjemaet faktisk kan bli vist — laster man
// scriptet ubetinget (slik det lå som et statisk <script>-tag i index.html
// før), kjører Cloudflare sin bakgrunns-PAT-sjekk (Private Access Token) mot
// challenges.cloudflare.com for ALLE sidevisninger, også for brukere som
// allerede er innlogget og aldri ser widgeten.
function sikreTurnstileLastet(){
  if (turnstileLastet) return;
  turnstileLastet = true;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

function renderAccountPanel(){
  el('accountLoggedOut').hidden = !!brukerCache;
  el('accountLoggedInn').hidden = !brukerCache;
  if (!brukerCache) sikreTurnstileLastet();
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
  // ⚙️-panelet er levning fra MVP-ens GitHub-token-oppsett (fortsatt brukt
  // read-only til å hente artskart-bondoya.json) — admin-only, samme
  // kosmetisk-skjuling-prinsipp som adminToggle over.
  el('setupToggle').hidden = !brukerCache || brukerCache.rolle !== 'admin';
  // Funnliste-knapp: alltid synlig for innloggede (de ser alltid alle egne
  // funn), men skjult for besøkende når admin har skrudd av offentlig
  // funnvisning (eller mens vi ennå ikke har fått bekreftet flagget —
  // fail-closed, se refreshFromRepo). Kosmetisk skjuling som resten av
  // panelet her; faktisk håndhevelse skjer server-side i listFunnOffentlig.
  el('listToggle').hidden = !brukerCache && !offentligFunnSynlig;
  if (mapCtx) mapCtx.settInnloggingsstatus(!!brukerCache);
}

// ---------- admin ----------

// Admin-panelet vokste til 6 stablede seksjoner i én lang rulling ("litt
// voldsomt", tilbakemelding 2026-07-16) — arkfaner i stedet. Alle seksjoners
// data lastes fortsatt eagerly ved åpning (se adminToggle-lytteren under),
// arkfanene er bare et rent visningslag oppå det — enklere enn lat lasting
// per fane, og ingen av seksjonene er tunge nok til at det trengs.
function wireAdminTabs(){
  const knapper = document.querySelectorAll('.adminTabBtn');
  function velgFane(navn){
    knapper.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === navn));
    document.querySelectorAll('.adminTabPanel').forEach(panel => {
      panel.hidden = panel.id !== `adminTab-${navn}`;
    });
  }
  knapper.forEach(btn => btn.addEventListener('click', () => velgFane(btn.dataset.tab)));
  velgFane('innstillinger');
}

function wireAdminPanel(){
  wireAdminTabs();
  el('adminToggle').addEventListener('click', async () => {
    toggleSheet('adminPanel');
    if (!el('adminPanel').hidden) {
      document.querySelector('.adminTabBtn[data-tab="innstillinger"]')?.click();
      await renderInnstillinger();
      tomArtSkjema();
      await renderAdminSkjulteArter();
      tomSideSkjema();
      await renderAdminSider();
      el('invitasjonNyLenke').hidden = true;
      await renderAdminInvitasjoner();
      await renderBrukerListe();
    }
  });

  el('funnSynligForPublicBtn').addEventListener('click', async () => {
    const nyVerdi = !adminInnstillingerCache.funnSynligForPublic;
    el('funnSynligForPublicBtn').disabled = true;
    try {
      adminInnstillingerCache = await window.ApiClient.settAdminInnstillinger({ funnSynligForPublic: nyVerdi });
      oppdaterFunnSynlighetKnapp();
      showToast(nyVerdi ? 'Offentlig funnvisning er nå PÅ.' : 'Offentlig funnvisning er nå AV.');
    } catch (e) {
      showToast('Feil: ' + e.message);
    } finally {
      el('funnSynligForPublicBtn').disabled = false;
    }
  });

  el('sideNyBtn').addEventListener('click', tomSideSkjema);

  el('sideLagreBtn').addEventListener('click', async () => {
    const felter = {
      tittel: el('sideTittelInput').value.trim(),
      slug: el('sideSlugInput').value.trim(),
      innhold: el('sideInnholdInput').value.trim(),
      synlighet: el('sideSynlighetSelect').value,
      status: el('sideStatusSelect').value,
    };
    el('sideAdminNote').textContent = 'Lagrer …';
    try {
      if (redigerSideId) {
        await window.ApiClient.oppdaterSide(redigerSideId, felter);
      } else {
        const opprettet = await window.ApiClient.opprettSide(felter);
        redigerSideId = opprettet.id;
      }
      el('sideAdminNote').textContent = 'Lagret ✓';
      await renderAdminSider();
    } catch (e) {
      el('sideAdminNote').textContent = 'Feil: ' + e.message;
    }
  });

  el('invitasjonGenererBtn').addEventListener('click', async () => {
    const epost = el('invitasjonEpostInput').value.trim();
    if (!epost) { showToast('Skriv inn e-posten til personen du inviterer.'); return; }
    el('invitasjonGenererBtn').disabled = true;
    try {
      const { token } = await window.ApiClient.opprettInvitasjon(epost);
      const lenke = `${location.origin}${location.pathname}?inviter=${token}`;
      el('invitasjonLenkeInput').value = lenke;
      el('invitasjonNyLenke').hidden = false;
      el('invitasjonEpostInput').value = '';
      await renderAdminInvitasjoner();
    } catch (e) {
      showToast('Feil: ' + e.message);
    } finally {
      el('invitasjonGenererBtn').disabled = false;
    }
  });

  el('invitasjonKopierBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el('invitasjonLenkeInput').value);
      showToast('Lenke kopiert.');
    } catch (e) {
      showToast('Kunne ikke kopiere — merk og kopier lenken manuelt.');
    }
  });

  wireArtSok();
  wireArtsomtaleSok();

  el('artSkjulBtn').addEventListener('click', async () => {
    const felter = {
      taxonId: el('artTaxonIdInput').value,
      visningsnavn: el('artVisningsnavnInput').value.trim(),
      grunn: el('artGrunnInput').value.trim(),
    };
    if (!felter.taxonId || !felter.visningsnavn) {
      el('artAdminNote').textContent = 'Fyll ut både taxonId og visningsnavn.';
      return;
    }
    el('artAdminNote').textContent = 'Lagrer …';
    try {
      await window.ApiClient.skjulArt(felter);
      tomArtSkjema();
      await renderAdminSkjulteArter();
      showToast('Arten er skjult — allerede registrerte funn er oppdatert.');
    } catch (e) {
      el('artAdminNote').textContent = 'Feil: ' + e.message;
    }
  });
}

// ---------- admin: dashboard ----------

function wireDashboardPanel(){
  el('dashboardApneBtn').addEventListener('click', async () => {
    toggleSheet('dashboardPanel', true);
    await renderAdminDashboard();
  });
}

function statKort(tall, etikett){
  return `<div class="statCard"><div class="statTall">${tall}</div><div class="statLabel">${escapeHtml(etikett)}</div></div>`;
}

async function renderAdminDashboard(){
  const container = el('dashboardInnhold');
  container.innerHTML = '<p class="hint">Laster …</p>';
  let d;
  try {
    d = await window.ApiClient.hentAdminDashboard();
  } catch (e) {
    container.innerHTML = `<p class="hint">Kunne ikke hente dashboard: ${escapeHtml(e.message)}</p>`;
    return;
  }

  const artstypeListe = d.funn.perArtstype.map((r) => `<li>${escapeHtml(r.artstype)}: ${r.antall}</li>`).join('') || '<li>Ingen funn ennå.</li>';
  const bidragsytereListe = d.funn.toppBidragsytere.map((r) => `<li>${escapeHtml(r.kortnavn)}: ${r.antall}</li>`).join('') || '<li>Ingen funn ennå.</li>';

  container.innerHTML = `
    <h3>Brukere</h3>
    <div class="statGrid">
      ${statKort(d.brukere.totalt, 'Totalt')}
      ${statKort(d.brukere.aktive, 'Aktive')}
      ${statKort(d.brukere.deaktiverte, 'Deaktiverte')}
      ${statKort(d.brukere.admins, 'Admin')}
      ${statKort(d.brukere.aktiverte, 'Aktiverte')}
      ${statKort(d.brukere.totalt - d.brukere.aktiverte, 'Ikke aktivert')}
    </div>
    <h3>Funn</h3>
    <div class="statGrid">
      ${statKort(d.funn.totalt, 'Totalt')}
      ${statKort(d.funn.denneManeden, 'Denne måneden')}
      ${statKort(d.funn.offentligSynlig, 'Offentlig synlig')}
      ${statKort(d.skjulteArter, 'Skjulte arter')}
    </div>
    <p class="hint"><strong>Per artstype:</strong></p>
    <ul>${artstypeListe}</ul>
    <p class="hint"><strong>Topp bidragsytere:</strong></p>
    <ul>${bidragsytereListe}</ul>
    <h3>Sider</h3>
    <div class="statGrid">
      ${statKort(d.sider.totalt, 'Totalt')}
      ${statKort(d.sider.publisert, 'Publisert')}
      ${statKort(d.sider.kladd, 'Kladd')}
    </div>
    <h3>Invitasjoner</h3>
    <div class="statGrid">
      ${statKort(d.invitasjoner.totalt, 'Totalt generert')}
      ${statKort(d.invitasjoner.brukt, 'Brukt')}
      ${statKort(d.invitasjoner.ubruktGyldig, 'Ubrukt, gyldig')}
      ${statKort(d.invitasjoner.utlopt, 'Utløpt')}
    </div>`;
}

async function renderInnstillinger(){
  const btn = el('funnSynligForPublicBtn');
  btn.disabled = true;
  btn.textContent = 'Laster …';
  try {
    adminInnstillingerCache = await window.ApiClient.hentAdminInnstillinger();
  } catch (e) {
    btn.textContent = 'Kunne ikke laste innstilling';
    return;
  }
  oppdaterFunnSynlighetKnapp();
  btn.disabled = false;
}

function oppdaterFunnSynlighetKnapp(){
  const btn = el('funnSynligForPublicBtn');
  btn.textContent = adminInnstillingerCache.funnSynligForPublic
    ? 'Skru av offentlig funnvisning'
    : 'Skru på offentlig funnvisning';
}

// Delt av renderArtSokResultater (admin, under) og renderSpeciesResults
// (registreringsflyten) — samme kort-mal begge steder. Viser artstype i
// tillegg til navn: uten den kan flere treff på samme søkeord (typisk flere
// sopparter, se samtale 2026-07-13 om "multer") være umulig å skille fra
// hverandre uten å åpne hvert enkelt.
function speciesResultButtonHtml(s, i){
  return `<button class="speciesResult" data-i="${i}">
    ${escapeHtml(s.norsk)} <em>${escapeHtml(s.latinsk)}</em>
    <span class="speciesType">${escapeHtml(s.artstype || 'ukjent type')}</span>
  </button>`;
}

// ---------- admin: arter (synlighet i det offentlige laget) ----------

// Samme lokale+live-søk-mønster som speciesSearch i registreringsflyten
// (se renderRegisterPanel) — henter live fra Artsdatabanken via /arter/sok,
// slik at admin kan skjule en hvilken som helst art, ikke bare de kuraterte
// i speciesCache (som kun dekker artene appen selv foreslår ved
// registrering).
function wireArtSok(){
  function renderArtSokResultater(lokale, eksterne){
    const alle = [...lokale, ...eksterne];
    el('artSokResultater').innerHTML =
      lokale.map((s, i) => speciesResultButtonHtml(s, i)).join('') +
      (eksterne.length ? '<p class="hint speciesResultsHint">Flere treff</p>' : '') +
      eksterne.map((s, i) => speciesResultButtonHtml(s, lokale.length + i)).join('');

    el('artSokResultater').querySelectorAll('.speciesResult').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = alle[Number(btn.dataset.i)];
        el('artTaxonIdInput').value = s.taxonId;
        el('artVisningsnavnInput').value = s.norsk;
        el('artSokResultater').innerHTML = '';
        el('artSokInput').value = s.norsk;
      });
    });
  }

  let sokTimer = null;
  el('artSokInput').addEventListener('input', (ev) => {
    const rawTerm = ev.target.value.trim();
    const term = rawTerm.toLowerCase();
    const lokaleTreff = term.length < 2 ? [] : speciesCache.filter(s =>
      s.norsk.toLowerCase().includes(term) || s.latinsk.toLowerCase().includes(term)
    ).slice(0, 6);
    renderArtSokResultater(lokaleTreff, []);

    clearTimeout(sokTimer);
    if (term.length < 2) return;
    sokTimer = setTimeout(async () => {
      const eksterneTreff = await window.ApiClient.sokArter(rawTerm);
      const lokaleNavn = new Set(lokaleTreff.map(s => s.norsk.toLowerCase()));
      const nyeTreff = eksterneTreff.filter(s => !lokaleNavn.has(s.norsk.toLowerCase()));
      // Ikke overskriv hvis admin har rukket å endre søket videre.
      if (el('artSokInput').value.trim().toLowerCase() === term) {
        renderArtSokResultater(lokaleTreff, nyeTreff);
      }
    }, 300);
  });
}

// ---------- admin: artsomtale ----------

// Samme søkemønster som wireArtSok() over, men skriver til arter_metadata
// (worker/api/src/routes/arter.js sin hentArtsbeskrivelse/settArtsbeskrivelse)
// i stedet for skjulte_arter — se migrations/0015 for hvorfor dette er en
// egen tabell fremfor et felt i data/species.json (delt per taxonId på
// tvers av alle funn av arten, ikke duplisert per funn eller begrenset til
// en kuratert liste).
function wireArtsomtaleSok(){
  let valgtTaxonId = null;
  let valgtLatinsk = '';
  let valgtNorsk = '';

  function renderResultater(lokale, eksterne){
    const alle = [...lokale, ...eksterne];
    el('artsomtaleSokResultater').innerHTML =
      lokale.map((s, i) => speciesResultButtonHtml(s, i)).join('') +
      (eksterne.length ? '<p class="hint speciesResultsHint">Flere treff</p>' : '') +
      eksterne.map((s, i) => speciesResultButtonHtml(s, lokale.length + i)).join('');

    el('artsomtaleSokResultater').querySelectorAll('.speciesResult').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const s = alle[Number(btn.dataset.i)];
        valgtTaxonId = s.taxonId;
        valgtLatinsk = s.latinsk;
        valgtNorsk = s.norsk;
        el('artsomtaleSokResultater').innerHTML = '';
        el('artsomtaleSokInput').value = s.norsk;
        el('artsomtaleValgtVisning').textContent = `Valgt: ${s.norsk} (taxonId ${s.taxonId}) — henter gjeldende omtale …`;
        el('artsomtaleLagreBtn').disabled = false;
        el('artsomtaleTekstInput').value = '';

        const gjeldende = await window.ApiClient.hentArtsbeskrivelse(valgtTaxonId, valgtLatinsk);
        el('artsomtaleValgtVisning').textContent = gjeldende.beskrivelse
          ? `Valgt: ${s.norsk} (taxonId ${s.taxonId}) — gjeldende kilde: ${gjeldende.kilde === 'wikipedia' ? 'Wikipedia (auto)' : 'admin'}`
          : `Valgt: ${s.norsk} (taxonId ${s.taxonId}) — ingen omtale ennå`;
        el('artsomtaleTekstInput').value = gjeldende.beskrivelse || '';
      });
    });
  }

  let sokTimer = null;
  el('artsomtaleSokInput').addEventListener('input', (ev) => {
    const rawTerm = ev.target.value.trim();
    const term = rawTerm.toLowerCase();
    const lokaleTreff = term.length < 2 ? [] : speciesCache.filter(s =>
      s.norsk.toLowerCase().includes(term) || s.latinsk.toLowerCase().includes(term)
    ).slice(0, 6);
    renderResultater(lokaleTreff, []);

    clearTimeout(sokTimer);
    if (term.length < 2) return;
    sokTimer = setTimeout(async () => {
      const eksterneTreff = await window.ApiClient.sokArter(rawTerm);
      const lokaleNavn = new Set(lokaleTreff.map(s => s.norsk.toLowerCase()));
      const nyeTreff = eksterneTreff.filter(s => !lokaleNavn.has(s.norsk.toLowerCase()));
      if (el('artsomtaleSokInput').value.trim().toLowerCase() === term) {
        renderResultater(lokaleTreff, nyeTreff);
      }
    }, 300);
  });

  el('artsomtaleLagreBtn').addEventListener('click', async () => {
    const tekst = el('artsomtaleTekstInput').value.trim();
    if (!valgtTaxonId) { el('artsomtaleNote').textContent = 'Velg en art først.'; return; }
    if (!tekst) { el('artsomtaleNote').textContent = 'Skriv en beskrivelse først.'; return; }
    el('artsomtaleNote').textContent = 'Lagrer …';
    try {
      await window.ApiClient.settArtsbeskrivelse(valgtTaxonId, tekst);
      artsbeskrivelseCache.delete(valgtTaxonId); // neste visning av et funn av arten skal hente den ferske teksten
      el('artsomtaleNote').textContent = 'Lagret.';
      el('artsomtaleValgtVisning').textContent = `Valgt: ${valgtNorsk} (taxonId ${valgtTaxonId}) — gjeldende kilde: admin`;
    } catch (e) {
      el('artsomtaleNote').textContent = 'Feil: ' + e.message;
    }
  });
}

function tomArtSkjema(){
  el('artSokInput').value = '';
  el('artSokResultater').innerHTML = '';
  el('artTaxonIdInput').value = '';
  el('artVisningsnavnInput').value = '';
  el('artGrunnInput').value = '';
  el('artAdminNote').textContent = '';
}

async function renderAdminSkjulteArter(){
  const container = el('artListeAdmin');
  container.innerHTML = '<p class="hint">Laster …</p>';
  let arter;
  try {
    arter = await window.ApiClient.hentAdminSkjulteArter();
  } catch (e) {
    container.innerHTML = `<p class="hint">Kunne ikke hente skjulte arter: ${escapeHtml(e.message)}</p>`;
    return;
  }

  container.innerHTML = arter.map((a) => `
    <div class="findRow" style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
      <div><strong>${escapeHtml(a.visningsnavn)}</strong> <span class="hint">taxonId ${a.taxon_id}</span></div>
      ${a.grunn ? `<div class="hint">${escapeHtml(a.grunn)}</div>` : ''}
      <div class="sheetActions">
        <button class="secondaryBtn" data-handling="vis" data-taxon-id="${a.taxon_id}">Vis igjen</button>
      </div>
    </div>`).join('') || '<p class="hint">Ingen arter skjult.</p>';

  container.querySelectorAll('[data-handling="vis"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await window.ApiClient.visArtIgjen(btn.dataset.taxonId);
        await renderAdminSkjulteArter();
        showToast('Arten er synlig igjen — allerede registrerte funn er oppdatert.');
      } catch (e) {
        showToast('Feil: ' + e.message);
      }
    });
  });
}

// ---------- admin: sider ----------

let redigerSideId = null; // null = "ny side"-skjema, ellers id-en som redigeres

async function renderAdminSider(){
  const container = el('sideListeAdmin');
  container.innerHTML = '<p class="hint">Laster …</p>';
  let sider;
  try {
    sider = await window.ApiClient.hentAdminSider();
  } catch (e) {
    container.innerHTML = `<p class="hint">Kunne ikke hente sider: ${escapeHtml(e.message)}</p>`;
    return;
  }

  container.innerHTML = sider.map((s) => `
    <div class="findRow" style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
      <div><strong>${escapeHtml(s.tittel)}</strong> <span class="hint">${escapeHtml(s.status)} · ${escapeHtml(s.synlighet)}</span></div>
      <div class="hint">/${escapeHtml(s.slug)}</div>
      <div class="sheetActions">
        <button class="secondaryBtn" data-handling="rediger" data-id="${s.id}">Rediger</button>
        <button class="secondaryBtn" data-handling="slett" data-id="${s.id}">Slett</button>
      </div>
    </div>`).join('') || '<p class="hint">Ingen sider ennå.</p>';

  container.querySelectorAll('[data-handling="rediger"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = sider.find((s) => s.id === parseInt(btn.dataset.id, 10));
      if (side) fyllSideSkjema(side);
    });
  });
  container.querySelectorAll('[data-handling="slett"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Slette denne siden? Kan ikke angres.')) return;
      try {
        await window.ApiClient.slettSide(btn.dataset.id);
        if (redigerSideId === parseInt(btn.dataset.id, 10)) tomSideSkjema();
        await renderAdminSider();
      } catch (e) {
        showToast('Feil: ' + e.message);
      }
    });
  });
}

function fyllSideSkjema(side){
  redigerSideId = side.id;
  el('sideTittelInput').value = side.tittel;
  el('sideSlugInput').value = side.slug;
  el('sideInnholdInput').value = side.innhold;
  el('sideSynlighetSelect').value = side.synlighet;
  el('sideStatusSelect').value = side.status;
  el('sideAdminNote').textContent = '';
}

function tomSideSkjema(){
  redigerSideId = null;
  el('sideTittelInput').value = '';
  el('sideSlugInput').value = '';
  el('sideInnholdInput').value = '';
  el('sideSynlighetSelect').value = 'palogget';
  el('sideStatusSelect').value = 'kladd';
  el('sideAdminNote').textContent = '';
}

// ---------- sider (personvern osv., offentlig visning) ----------

async function renderKontoSiderListe(){
  const container = el('sideLenker');
  let sider;
  try {
    sider = await window.ApiClient.hentSider();
  } catch (e) {
    return; // stille feil — sidelenker er ikke kritisk for appens kjernefunksjon
  }
  if (!sider.length) { container.innerHTML = ''; return; }

  container.innerHTML = sider.map((s) =>
    `<button class="linkBtn" data-slug="${escapeHtml(s.slug)}">${escapeHtml(s.tittel)}</button>`
  ).join('');
  container.querySelectorAll('[data-slug]').forEach((btn) => {
    btn.addEventListener('click', () => apneSide(btn.dataset.slug));
  });
}

async function apneSide(slug){
  const container = el('sideContent');
  container.innerHTML = '<p class="hint">Laster …</p>';
  toggleSheet('sidePanel', true);
  try {
    const side = await window.ApiClient.hentSide(slug);
    container.innerHTML = `<h2>${escapeHtml(side.tittel)}</h2>${renderSideInnhold(side.innhold)}`;
  } catch (e) {
    container.innerHTML = '<p class="hint">Fant ikke siden.</p>';
  }
}

// Ren tekst, aldri HTML/markdown — escapeHtml() (samme funksjon som resten
// av appen bruker) hindrer XSS via lagret sideinnhold, tomme linjer blir nye
// avsnitt, enkle linjeskift blir <br>.
function renderSideInnhold(innhold){
  return innhold.split(/\n{2,}/).map((avsnitt) =>
    `<p>${escapeHtml(avsnitt).replace(/\n/g, '<br>')}</p>`
  ).join('');
}

// ---------- invitasjon (registrering via lenke) ----------

function wireInviterPanel(){
  el('inviterRegistrerBtn').addEventListener('click', async () => {
    const kortnavn = el('inviterKortnavnInput').value.trim();
    if (!kortnavn) { el('inviterNote').textContent = 'Skriv inn kortnavnet ditt.'; return; }

    el('inviterNote').textContent = 'Registrerer …';
    try {
      // E-post sendes bevisst IKKE med herfra — den er alltid bundet
      // server-side til invitasjonen (sikkerhetsfiks, se
      // worker/api/src/lib/invitasjoner.js).
      await window.ApiClient.registrerMedInvitasjon(inviterToken, { kortnavn });
      toggleSheet('inviterPanel', false);
      showToast(`Velkommen, ${kortnavn}!`);
      await sjekkSesjon();
      await refreshFromRepo();
    } catch (e) {
      el('inviterNote').textContent = 'Feil: ' + e.message;
    }
  });
}

// Leser ?inviter=<token> fra URL-en ved oppstart. Fjerner parameteren fra
// URL-en uansett utfall (history.replaceState) — et ubrukt/ugyldig forsøk
// skal ikke gjenta seg ved en vanlig sideoppdatering.
async function haandterInvitasjonFraUrl(){
  const params = new URLSearchParams(location.search);
  const token = params.get('inviter');
  if (!token) return;

  params.delete('inviter');
  const nyUrl = location.pathname + (params.toString() ? `?${params}` : '') + location.hash;
  history.replaceState(null, '', nyUrl);

  let sjekk;
  try {
    sjekk = await window.ApiClient.sjekkInvitasjon(token);
  } catch (e) {
    showToast('Kunne ikke sjekke invitasjonslenken.');
    return;
  }
  if (!sjekk.gyldig) {
    showToast('Denne invitasjonslenken er ugyldig eller utløpt.');
    return;
  }

  inviterToken = token;
  el('inviterKortnavnInput').value = '';
  el('inviterEpostInput').value = sjekk.epost;
  el('inviterNote').textContent = '';
  toggleSheet('inviterPanel', true);
}

// ---------- admin: invitasjoner ----------

async function renderAdminInvitasjoner(){
  const container = el('invitasjonListe');
  container.innerHTML = '<p class="hint">Laster …</p>';
  let invitasjoner;
  try {
    invitasjoner = await window.ApiClient.hentAdminInvitasjoner();
  } catch (e) {
    container.innerHTML = `<p class="hint">Kunne ikke hente invitasjoner: ${escapeHtml(e.message)}</p>`;
    return;
  }

  container.innerHTML = invitasjoner.map((i) => {
    // epost mangler kun for invitasjoner opprettet før sikkerhetsfiksen
    // (migrations/0009) — permanent ikke-innløsbare, se lib/invitasjoner.js.
    const utlopt = !i.brukt && (i.utloper < Date.now() || !i.epost);
    let statusTekst;
    if (i.brukt) statusTekst = `brukt av ${i.brukt_av_kortnavn || 'ukjent'}`;
    else if (utlopt) statusTekst = 'utløpt';
    else statusTekst = 'ubrukt';

    return `
      <div class="findRow" style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
        <div><strong>${escapeHtml(i.epost || 'ukjent e-post')}</strong></div>
        <div><span class="hint">Generert av ${escapeHtml(i.opprettet_av_kortnavn)} — ${escapeHtml(statusTekst)}</span></div>
        <div class="sheetActions">
          <button class="secondaryBtn" data-handling="slett" data-id="${i.id}" ${i.brukt ? 'disabled' : ''}>Trekk tilbake</button>
        </div>
      </div>`;
  }).join('') || '<p class="hint">Ingen invitasjoner ennå.</p>';

  container.querySelectorAll('[data-handling="slett"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await window.ApiClient.slettInvitasjon(btn.dataset.id);
        await renderAdminInvitasjoner();
      } catch (e) {
        showToast('Feil: ' + e.message);
      }
    });
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

  // Permanent slettede brukere blir aldri fjernet fra tabellen — kun
  // e-post-skrubbet (se slettBrukerPermanent() i worker/api: funn sin
  // fremmednøkkel til bruker-id ville brukket ellers) — og har ingen
  // videre handlinger tilgjengelig. Skjules derfor som standard: uten
  // dette forble raden liggende i akkurat samme liste med bare en liten
  // tekstendring, som gjorde en vellykket sletting umulig å se
  // ("ser ikke ut til å slette", tilbakemelding 2026-07-16).
  const slettede = brukere.filter(b => b.slettet_tidspunkt);
  const synlige = visSlettedeBrukere ? brukere : brukere.filter(b => !b.slettet_tidspunkt);

  const toggleHtml = slettede.length
    ? `<button id="brukerVisSlettedeBtn" class="linkBtn">${visSlettedeBrukere ? 'Skjul' : 'Vis'} ${slettede.length} slettet${slettede.length === 1 ? '' : 'e'}</button>`
    : '';
  const listeHtml = synlige.map((b) => {
    const slettetPermanent = !!b.slettet_tidspunkt;
    // /meg returnerer ikke bruker-id, kun epost/kortnavn/rolle — sammenlign på
    // epost i stedet (unikt, og uendret for innlogget admin siden
    // selv-sletting/-deaktivering avvises server-side uansett).
    const erSelv = brukerCache && b.epost === brukerCache.epost;
    return `
      <div class="findRow" style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
        <div><strong>${escapeHtml(b.kortnavn)}</strong> <span class="hint">${escapeHtml(b.rolle)}</span></div>
        <div class="hint">${escapeHtml(b.epost)} — ${slettetPermanent ? 'permanent slettet' : b.status}</div>
        <div class="hint">${b.aktivert_tidspunkt
          ? `Aktivert ${new Date(b.aktivert_tidspunkt.replace(' ', 'T') + 'Z').toLocaleDateString('no-NO')}`
          : 'Registrert, men ikke aktivert ennå — har aldri bedt om innloggingslenke selv'}</div>
        <div class="sheetActions">
          <button class="secondaryBtn" data-handling="status" data-id="${b.id}" data-neste="${b.status === 'aktiv' ? 'deaktivert' : 'aktiv'}"
            ${slettetPermanent || erSelv ? 'disabled' : ''}>${b.status === 'aktiv' ? 'Deaktiver' : 'Reaktiver'}</button>
          <button class="secondaryBtn" data-handling="slett" data-id="${b.id}"
            ${slettetPermanent || erSelv ? 'disabled' : ''}>Slett permanent</button>
        </div>
      </div>`;
  }).join('') || '<p class="hint">Ingen brukere.</p>';
  container.innerHTML = toggleHtml + listeHtml;

  const brukerVisSlettedeBtn = el('brukerVisSlettedeBtn');
  if (brukerVisSlettedeBtn) {
    brukerVisSlettedeBtn.addEventListener('click', () => {
      visSlettedeBrukere = !visSlettedeBrukere;
      renderBrukerListe();
    });
  }

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
        showToast('Bruker slettet.');
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
  el('setupToggle').addEventListener('click', () => toggleSheet('setupPanel'));

  el('ghConnectBtn').addEventListener('click', async () => {
    const owner = el('ghOwner').value.trim();
    const repo = el('ghRepo').value.trim();
    const token = el('ghToken').value.trim();
    if (!owner || !repo || !token) {
      el('ghNote').textContent = 'Fyll ut eier, repo og token.';
      return;
    }
    el('ghNote').textContent = 'Kobler til …';
    try {
      const branch = await window.GhStore.detectDefaultBranch(owner, repo, token);
      window.GhStore.setConfig({ owner, repo, token, branch });
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

// Versjonen vises her (ikke bare i det admin-only ⚙️-panelet) fordi vanlige
// innloggede brukere ellers ikke hadde noe sted å se hvilken versjon som
// kjører — etterspurt 2026-07-13.
function updateSyncPill(){
  const pill = el('syncStatus');
  pill.hidden = false;
  if (!brukerCache) { pill.textContent = 'Logg på for artsobservasjoner'; return; }
  pill.textContent = `${navigator.onLine ? '🟢 Tilkoblet' : '🟡 Offline'} · v${APP_VERSION}`;
}

async function trySync(){
  const result = await window.OfflineQueue.syncQueue((item, status, feilmelding) => {
    if (status === 'ferdig') showToast('Funn synkronisert ✓');
    // Uten dette forsvant en synk-feil sporløst for brukeren — funnet ble
    // stående i køen med ingen synlig forklaring på hvorfor, se
    // offline-queue.js sin syncQueue().
    else if (status === 'feilet') showToast(`Kunne ikke synke et funn ennå: ${feilmelding}. Prøver igjen senere.`);
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

// Referansebilder for KI-kandidatene, hentet async ETTER at kortene
// allerede vises (samme "ikke-blokkerende visningsdetalj"-mønster som
// lastArtsbeskrivelse() i funndetaljer) — KI-kandidater har ingen taxonId
// å slå opp mot (se /arter/miniatyrbilde), så dette er et navnebasert,
// ukachet oppslag per kandidat, parallelt. isConnected-sjekken luker ut et
// sent svar for et kort som ikke lenger finnes (brukeren avbrøt/re-rendret
// panelet før svaret kom tilbake).
function lastKandidatMiniatyrer(alternativer){
  alternativer.forEach(async (a, i) => {
    const wrap = document.querySelector(`.candidateThumbWrap[data-thumb-idx="${i}"]`);
    if (!wrap) return;
    const { thumbnailUrl } = await window.ApiClient.hentArtMiniatyrbilde(a.latinsk);
    if (!thumbnailUrl || !wrap.isConnected) return;
    wrap.innerHTML = `<img src="${escapeHtml(thumbnailUrl)}" class="candidateThumb" alt="">`;
  });
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
  pendingKiCropBlob = null;
  // Bekreft/beskjær-steg før KI kjører — se renderRegisterPanel sin
  // cropping-state og kjorKiGjenkjenning() under.
  renderRegisterPanel({ cropping: true });
  toggleSheet('registerPanel', true);
}

// pendingKiCropBlob (satt av beskjæringssteget i renderRegisterPanel, hvis
// brukeren valgte å beskjære) sendes til KI i stedet for pendingImageBlob
// når den finnes — det lagrede funn-bildet forblir alltid det ubeskårne
// pendingImageBlob, uavhengig av hva KI faktisk analyserte.
async function kjorKiGjenkjenning(){
  renderRegisterPanel({ scanning: true });
  try {
    const hint = buildSpeciesHintList();
    pendingKiResultat = await window.KiClient.gjenkjenn(pendingKiCropBlob || pendingImageBlob, hint);
    console.debug('KI-svar', pendingKiResultat);
  } catch (err) {
    console.warn('KI-gjenkjenning feilet', err);
    pendingKiResultat = null;
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

// Beskjærer et allerede lastet <img>-element til et rektangel i bildets egne
// naturlige pikselkoordinater (fra renderRegisterPanel sin beskjæringssteg),
// samme kvalitetskonvensjon som compressImage. Kun brukt til KI-analyse —
// erstatter ALDRI pendingImageBlob (det lagrede funn-bildet), se
// kjorKiGjenkjenning().
function cropToBlob(img, rect){
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    canvas.getContext('2d').drawImage(
      img, rect.x, rect.y, rect.width, rect.height,
      0, 0, canvas.width, canvas.height
    );
    canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.8);
  });
}

// Vises når KI er usikker/ikke finner noe — ren tekst, ingen KI-proxy-
// avhengighet (proxyen returnerer i dag ingen kvalitets-/usikkerhetssignal).
const FOTOTIPS_HTML = `
  <div class="fototips">
    <strong>Tips for et lettere gjenkjennelig bilde:</strong>
    <ul>
      <li>Kom så nært som mulig uten å forstyrre dyret/planten</li>
      <li>Sørg for godt lys, unngå sterk motlys</li>
      <li>Fokuser på selve arten, ikke bakgrunnen</li>
      <li>Hold kameraet i ro</li>
    </ul>
  </div>`;

function renderRegisterPanel(state){
  const c = el('registerContent');
  const previewUrl = pendingImageBlob ? URL.createObjectURL(pendingImageBlob) : null;

  if (state.cropping) {
    c.innerHTML = `
      <div class="cropWrap" id="cropWrap">
        <img src="${previewUrl}" class="cropImg" id="cropImg" alt="">
        <div class="cropBox" id="cropBox" hidden></div>
      </div>
      <p class="hint">Dra over bildet for å velge utsnittet KI skal analysere (valgfritt) — hele bildet lagres uansett på funnet.</p>
      <div class="sheetActions">
        <button id="brukUtsnittBtn" class="primaryBtn" disabled>Bruk utsnitt</button>
        <button id="analyserHeleBtn" class="secondaryBtn">Analyser hele bildet</button>
      </div>`;
    wireCropInteraction();
    return;
  }

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
        ${alternativer.map((a, i) => {
          const count = nearbyCountFor(a.norsk);
          return `
          <button class="candidateCard" data-idx="${i}">
            <span class="candidateThumbWrap" data-thumb-idx="${i}"></span>
            <strong>${escapeHtml(a.norsk)}</strong>
            <span class="artstypeBadge">${escapeHtml(a.artstype || '')}</span>
            <span class="konfidensBadge">${Math.round((a.konfidens||0)*100)} %</span>
            ${count ? `<span class="hint">Sett ${count} ganger i nærheten før</span>` : ''}
            ${a.saertrekk ? `<span class="saertrekk">${escapeHtml(a.saertrekk)}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
      ${FOTOTIPS_HTML}`;
  } else {
    kiHtml = `<p class="hint">Fant ikke arten automatisk. Velg art manuelt under.</p>${FOTOTIPS_HTML}`;
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
  if (alternativer.length) lastKandidatMiniatyrer(alternativer);

  const pickBtn = el('pickPosBtn') || el('changePosBtn');
  if (pickBtn) pickBtn.addEventListener('click', pickPositionOnMap);
  el('findDato').addEventListener('change', (ev) => {
    const d = new Date(ev.target.value);
    if (!isNaN(d)) pendingTimestamp = d;
  });

  // pendingArt overlever re-rendering av panelet (f.eks. etter posisjonsvalg
  // i kart, se pickPositionOnMap) — kun sett KI sitt auto-forslag som
  // startverdi hvis brukeren ikke allerede har valgt noe selv.
  //
  // taxonId følger med her og i de to setValgt()-kallene under (fra søk og
  // KI-kandidater) — manglet siden aller første MVP-commit, med den
  // konsekvens at art_taxon_id ble NULL i databasen for absolutt alle funn
  // (bekreftet 2026-07-16 mot produksjons-D1), uansett om arten kom fra et
  // ekte Artsdatabanken-søketreff. KI-kandidater har uansett aldri en
  // taxonId (ki-proxy gjør ren bildegjenkjenning, ikke taxonoppslag) — der
  // blir feltet fortsatt undefined, som er korrekt.
  if (!pendingArt && beste && autoVelg) {
    pendingArt = { norsk: beste.art.norsk, latinsk: beste.art.latinsk, artstype: beste.artstype, taxonId: beste.art.taxonId };
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
      setValgt({ norsk: a.norsk, latinsk: a.latinsk, artstype: a.artstype, taxonId: a.taxonId });
    });
  });

  // Lokale (kuraterte 17) treff vises instant; bredere treff hentes live fra
  // Artsdatabanken via Workerens /arter/sok-proxy (se worker/api/src/routes/
  // arter.js) — erstatter den gamle "bruk som ny art"-fritekstknappen.
  // Uventede funn (som en elg som har svømt ut til øya) dekkes nå av det
  // brede søket i stedet for fri tekst, siden Artsdatabanken sin taxonomi
  // dekker praktisk talt alle norske arter.
  function renderSpeciesResults(lokale, eksterne){
    const alle = [...lokale, ...eksterne];
    el('speciesResults').innerHTML =
      lokale.map((s, i) => speciesResultButtonHtml(s, i)).join('') +
      (eksterne.length ? '<p class="hint speciesResultsHint">Flere treff</p>' : '') +
      eksterne.map((s, i) => speciesResultButtonHtml(s, lokale.length + i)).join('');

    el('speciesResults').querySelectorAll('.speciesResult').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = alle[Number(btn.dataset.i)];
        setValgt({ norsk: s.norsk, latinsk: s.latinsk, artstype: s.artstype, taxonId: s.taxonId });
        el('speciesResults').innerHTML = '';
        el('speciesSearch').value = s.norsk;
      });
    });
  }

  let sokTimer = null;
  el('speciesSearch').addEventListener('input', (ev) => {
    const rawTerm = ev.target.value.trim();
    const term = rawTerm.toLowerCase();
    const lokaleTreff = term.length < 2 ? [] : speciesCache.filter(s =>
      s.norsk.toLowerCase().includes(term) || s.latinsk.toLowerCase().includes(term)
    ).slice(0, 6);
    renderSpeciesResults(lokaleTreff, []);

    clearTimeout(sokTimer);
    if (term.length < 2) return;
    sokTimer = setTimeout(async () => {
      const eksterneTreff = await window.ApiClient.sokArter(rawTerm);
      const lokaleNavn = new Set(lokaleTreff.map(s => s.norsk.toLowerCase()));
      const nyeTreff = eksterneTreff.filter(s => !lokaleNavn.has(s.norsk.toLowerCase()));
      // Ikke overskriv hvis brukeren har rukket å endre søket videre.
      if (el('speciesSearch').value.trim().toLowerCase() === term) {
        renderSpeciesResults(lokaleTreff, nyeTreff);
      }
    }, 300);
  });

  el('cancelFindBtn').addEventListener('click', () => toggleSheet('registerPanel', false));
  el('saveFindBtn').addEventListener('click', () => saveFind(pendingArt));
}

// Enkel én-dra beskjæringsboks over .cropImg (object-fit: contain, så hele
// kildebildet er synlig — ulikt .previewImg/.scanImg som bruker cover).
// Regner om skjermkoordinater til bildets naturlige pikselkoordinater via
// contain-fit-geometrien (skala + letterbox-offset), siden rendret
// bildestørrelse sjelden matcher kildebildets sideforhold 1:1.
function wireCropInteraction(){
  const wrap = el('cropWrap');
  const img = el('cropImg');
  const box = el('cropBox');
  const brukBtn = el('brukUtsnittBtn');
  let start = null; // {lx, ly} — lokale koordinater relativt til wrap
  let rectNatural = null;

  function bildeGeometri(){
    const wrapRect = wrap.getBoundingClientRect();
    const skala = Math.min(wrapRect.width / img.naturalWidth, wrapRect.height / img.naturalHeight);
    const rendretBredde = img.naturalWidth * skala;
    const rendretHoyde = img.naturalHeight * skala;
    return {
      wrapRect, skala,
      offsetX: (wrapRect.width - rendretBredde) / 2,
      offsetY: (wrapRect.height - rendretHoyde) / 2,
      rendretBredde, rendretHoyde,
    };
  }

  function lokaltPunkt(ev, geo){
    const lx = ev.clientX - geo.wrapRect.left;
    const ly = ev.clientY - geo.wrapRect.top;
    return {
      lx: Math.min(Math.max(lx, geo.offsetX), geo.offsetX + geo.rendretBredde),
      ly: Math.min(Math.max(ly, geo.offsetY), geo.offsetY + geo.rendretHoyde),
    };
  }

  wrap.addEventListener('pointerdown', (ev) => {
    if (!img.naturalWidth) return;
    wrap.setPointerCapture(ev.pointerId);
    start = lokaltPunkt(ev, bildeGeometri());
    box.hidden = false;
  });
  wrap.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const geo = bildeGeometri();
    const nu = lokaltPunkt(ev, geo);
    const left = Math.min(start.lx, nu.lx);
    const top = Math.min(start.ly, nu.ly);
    const bredde = Math.abs(nu.lx - start.lx);
    const hoyde = Math.abs(nu.ly - start.ly);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${bredde}px`;
    box.style.height = `${hoyde}px`;

    rectNatural = {
      x: (left - geo.offsetX) / geo.skala,
      y: (top - geo.offsetY) / geo.skala,
      width: bredde / geo.skala,
      height: hoyde / geo.skala,
    };
    brukBtn.disabled = bredde < 20 || hoyde < 20; // for liten boks er ikke meningsfull
  });
  wrap.addEventListener('pointerup', () => { start = null; });
  wrap.addEventListener('pointercancel', () => { start = null; });

  brukBtn.addEventListener('click', () => {
    if (!rectNatural) return;
    cropToBlob(img, rectNatural).then((blob) => {
      pendingKiCropBlob = blob;
      kjorKiGjenkjenning();
    });
  });
  el('analyserHeleBtn').addEventListener('click', () => {
    pendingKiCropBlob = null;
    kjorKiGjenkjenning();
  });
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

// Sorteringsvalg — 'kiKonfidens' er admin-only (nyttig for å finne
// gjenkjenninger som bør dobbeltsjekkes), resten er for alle innloggede.
const SORTERINGER = [
  { v: 'nyeste', tekst: 'Nyeste' },
  { v: 'eldste', tekst: 'Eldste' },
  { v: 'alfabetisk', tekst: 'Alfabetisk' },
  { v: 'flestFunn', tekst: 'Flest funn' },
];
const SORTERING_KI_KONFIDENS = { v: 'kiKonfidens', tekst: 'KI-konfidens (lavest først)' };

// Grupperingsvalg — 'bruker' vises kun i "Alle funn"-visningen (i "Mine
// funn" er alle rader uansett samme bruker).
const GRUPPERINGER = [
  { v: 'ingen', tekst: 'Ingen' },
  { v: 'art', tekst: 'Art' },
  { v: 'artstype', tekst: 'Artstype' },
  { v: 'maned', tekst: 'Måned' },
];
const GRUPPERING_BRUKER = { v: 'bruker', tekst: 'Bruker' };

function erAdmin(){
  return !!brukerCache && brukerCache.rolle === 'admin';
}

function wireListPanel(){
  // renderSortRow() re-kjøres ved hver åpning (ikke bare her ved oppstart) —
  // brukerCache.rolle kan endre seg mellom innlasting og et senere
  // logg inn/ut mens panelet er lukket, og admin-only-radene skal reflektere
  // gjeldende status, ikke status ved sideinnlasting.
  el('listToggle').addEventListener('click', () => { renderSortRow(); renderList(); toggleSheet('listPanel'); });
  el('filterIndicator').addEventListener('click', () => { renderSortRow(); renderList(); toggleSheet('listPanel', true); });

  const visninger = ['alle', 'mine'];
  el('visningRow').innerHTML = visninger.map(v =>
    `<button class="filterChip${v===activeVisning?' active':''}" data-v="${v}">${v === 'mine' ? 'Mine funn' : 'Alle funn'}</button>`
  ).join('');
  el('visningRow').querySelectorAll('.filterChip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeVisning = btn.dataset.v;
      el('visningRow').querySelectorAll('.filterChip').forEach(b => b.classList.toggle('active', b === btn));
      // "Bruker"-gruppering gir ikke mening i "Mine funn" (kun én bruker der).
      if (activeVisning !== 'alle' && activeGroup === 'bruker') activeGroup = 'ingen';
      renderGroupRow();
      renderFindsPaKart();
      renderList();
    });
  });

  // Dropdown i stedet for chip-rad (endret 2026-07-13) — chip-raden krevde
  // horisontal scroll for å se alle artstyper, og ble bare verre etter hvert
  // som flere artstyper (sopp, ev. fisk/skjell) kom til. Statisk liste, ikke
  // avhengig av innloggingsstatus som sortSelect/groupSelect — trengs derfor
  // ikke en egen renderFilterRow() kalt på nytt ved hver åpning.
  el('filterSelect').innerHTML = ['alle', ...ARTSTYPER].map(t =>
    `<option value="${t}"${t===activeFilter?' selected':''}>${t === 'alle' ? 'Alle typer' : t.charAt(0).toUpperCase() + t.slice(1)}</option>`
  ).join('');
  el('filterSelect').onchange = () => {
    activeFilter = el('filterSelect').value;
    renderFindsPaKart();
    renderList();
  };

  renderGroupRow();
  renderSortRow();
}

// Sortering (KI-konfidens-valget) og "kun usikre"-filteret er admin-only —
// re-rendret ved hver åpning av listepanelet (se listToggle over), ikke bare
// ved oppstart, slik at de reflekterer gjeldende innloggingsstatus.
function renderSortRow(){
  const sorteringer = erAdmin() ? [...SORTERINGER, SORTERING_KI_KONFIDENS] : SORTERINGER;
  if (!erAdmin() && activeSort === 'kiKonfidens') activeSort = 'nyeste';
  el('sortSelect').innerHTML = sorteringer.map(s =>
    `<option value="${s.v}"${s.v===activeSort?' selected':''}>${escapeHtml(s.tekst)}</option>`
  ).join('');
  // .onchange (ikke addEventListener) — renderSortRow() kjøres på nytt hver
  // gang listepanelet åpnes, og selectens innerHTML byttes ut, ikke selve
  // elementet, så addEventListener ville stablet opp én lytter per åpning.
  el('sortSelect').onchange = () => {
    activeSort = el('sortSelect').value;
    renderList();
  };

  // "Kun usikre KI-gjenkjenninger" — admin-only, hjelper med å finne
  // gjenkjenninger som bør dobbeltsjekkes (samme terskel som appen selv
  // bruker for å auto-velge et KI-forslag).
  if (erAdmin()) {
    el('usikreRow').hidden = false;
    el('usikreRow').innerHTML =
      `<button class="filterChip${kunUsikre?' active':''}" id="kunUsikreChip">Kun usikre KI-gjenkjenninger</button>`;
    el('kunUsikreChip').addEventListener('click', () => {
      kunUsikre = !kunUsikre;
      el('kunUsikreChip').classList.toggle('active', kunUsikre);
      renderFindsPaKart();
      renderList();
    });
  } else {
    el('usikreRow').hidden = true;
    el('usikreRow').innerHTML = '';
    kunUsikre = false;
  }
}

function renderGroupRow(){
  const grupperinger = activeVisning === 'alle' ? [...GRUPPERINGER, GRUPPERING_BRUKER] : GRUPPERINGER;
  el('groupSelect').innerHTML = grupperinger.map(g =>
    `<option value="${g.v}"${g.v===activeGroup?' selected':''}>${escapeHtml(g.tekst)}</option>`
  ).join('');
  el('groupSelect').onchange = () => {
    activeGroup = el('groupSelect').value;
    renderList();
  };
}

function synligeFunn(){
  return funnCache.filter(f =>
    (activeFilter === 'alle' || f.artstype === activeFilter) &&
    (activeVisning === 'alle' || f.erEgenRegistrering) &&
    (!kunUsikre || (f.kiKonfidens || 0) < window.KiClient.KONFIDENS_AUTO_TERSKEL)
  );
}

function sorterteFunn(list){
  const sortert = list.slice();
  if (activeSort === 'nyeste') sortert.sort((a, b) => new Date(b.tidspunkt) - new Date(a.tidspunkt));
  else if (activeSort === 'eldste') sortert.sort((a, b) => new Date(a.tidspunkt) - new Date(b.tidspunkt));
  else if (activeSort === 'alfabetisk') sortert.sort((a, b) => (a.art?.norsk || '').localeCompare(b.art?.norsk || '', 'no'));
  else if (activeSort === 'kiKonfidens') sortert.sort((a, b) => (a.kiKonfidens || 0) - (b.kiKonfidens || 0));
  else if (activeSort === 'flestFunn') {
    const antallPerArt = {};
    for (const f of list) antallPerArt[f.art?.norsk] = (antallPerArt[f.art?.norsk] || 0) + 1;
    sortert.sort((a, b) => (antallPerArt[b.art?.norsk] || 0) - (antallPerArt[a.art?.norsk] || 0));
  }
  return sortert;
}

// Grupperer den sorterte listen til seksjoner. Seksjonene sorteres alltid
// etter antall medlemmer (flest funn øverst, jf. konsept.md) — activeSort
// styrer rekkefølgen INNENFOR hver seksjon.
function gruppertFunn(sortertListe){
  if (activeGroup === 'ingen') return [{ tittel: null, funn: sortertListe }];
  const grupper = new Map();
  for (const f of sortertListe) {
    let nokkel;
    if (activeGroup === 'art') nokkel = f.art?.norsk || 'Ukjent art';
    else if (activeGroup === 'artstype') nokkel = f.artstype || 'annet';
    else if (activeGroup === 'maned') nokkel = new Date(f.tidspunkt).toLocaleDateString('no-NO', { year: 'numeric', month: 'long' });
    else if (activeGroup === 'bruker') nokkel = f.registrertAv || 'Ukjent bruker';
    else nokkel = 'Annet';
    if (!grupper.has(nokkel)) grupper.set(nokkel, []);
    grupper.get(nokkel).push(f);
  }
  return Array.from(grupper.entries())
    .map(([tittel, funn]) => ({ tittel, funn }))
    .sort((a, b) => b.funn.length - a.funn.length);
}

// mapCtx kan være null i det (svært sjeldne) tilfellet kartinitialisering
// feilet permanent, se initMapNarKlar() — resten av appen (innlogging,
// liste, registrering) skal likevel fungere, bare uten kartvisning.
function renderFindsPaKart(){
  if (mapCtx) renderFinds(mapCtx.map, mapCtx.findsLayer, synligeFunn(), 'alle');
  oppdaterFilterIndikator();
}

// Synlig markør over kartet når funn faktisk er filtrert bort — uten denne
// var eneste måte å oppdage et aktivt filter på å åpne Registrerte funn
// (rapportert 2026-07-13: brukte lang tid før man skjønte hvorfor enkelte
// funn "manglet" på kartet etter å ha satt et filter og navigert bort en
// stund). Kalles fra renderFindsPaKart() — samme knutepunkt som allerede
// kjøres hver gang et filter endres.
function oppdaterFilterIndikator(){
  const deler = [];
  if (activeFilter !== 'alle') deler.push(activeFilter.charAt(0).toUpperCase() + activeFilter.slice(1));
  if (activeVisning !== 'alle') deler.push('Mine funn');
  if (kunUsikre) deler.push('Kun usikre');

  const el_ = el('filterIndicator');
  if (deler.length) {
    el_.textContent = `🔍 ${deler.join(' · ')}`;
    el_.hidden = false;
  } else {
    el_.hidden = true;
  }
}

// Husker hvilke grupper brukeren selv har lukket, på tvers av re-render
// (renderList() kjøres på nytt ved hvert filter-/sorterings-/synkbytte) —
// uten dette ville et lukket-valg blitt tilbakestilt til åpent igjen ved
// neste re-render. Nøkkelen er selve gruppetittelen (art/artstype/måned/
// bruker), url-kodet i data-attributtet for å unngå å måtte HTML-
// attributt-escape en fritekst-tittel (f.eks. et brukernavn med anførselstegn).
let lukkedeGrupper = new Set();

function renderList(){
  const seksjoner = gruppertFunn(sorterteFunn(synligeFunn()));
  const visKonfidens = erAdmin();
  el('findList').innerHTML = seksjoner.map(seksjon => {
    const funnHtml = seksjon.funn.map(f => `
      <button class="findRow" data-id="${f.id}">
        ${f.bildeUrl ? `<img src="${window.ApiClient.bildeUrl(f.id)}" class="findThumb" alt="" loading="lazy">` : '<div class="findThumb"></div>'}
        <span class="findRowText">
          <strong>${escapeHtml(f.art?.norsk || 'Ukjent')}</strong>
          <span class="hint">${new Date(f.tidspunkt).toLocaleDateString('no-NO')}${f.registrertAv ? ' · ' + escapeHtml(f.registrertAv) : ''}</span>
        </span>
        ${visKonfidens && f.kiKonfidens ? `<span class="konfidensBadge">${Math.round(f.kiKonfidens*100)} %</span>` : ''}
      </button>`).join('');

    if (!seksjon.tittel) return funnHtml;

    const apen = !lukkedeGrupper.has(seksjon.tittel);
    return `
      <details class="findGroup"${apen ? ' open' : ''} data-tittel="${encodeURIComponent(seksjon.tittel)}">
        <summary class="findGroupHeader">${escapeHtml(seksjon.tittel)} <span class="hint">(${seksjon.funn.length})</span></summary>
        ${funnHtml}
      </details>`;
  }).join('') || '<p class="hint">Ingen registrerte funn ennå.</p>';

  el('findList').querySelectorAll('.findGroup').forEach(details => {
    details.addEventListener('toggle', () => {
      const tittel = decodeURIComponent(details.dataset.tittel);
      if (details.open) lukkedeGrupper.delete(tittel);
      else lukkedeGrupper.add(tittel);
    });
  });

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
  apentFunnId = funn.id; // se lastArtsbeskrivelse() — luker ut et sent svar for et funn som ikke lenger vises
  const s = speciesCache.find(sp => sp.latinsk === funn.art?.latinsk) || {};
  const count = nearbyCountFor(funn.art?.norsk || '');

  // .detailImg (object-fit: contain, ikke .previewImg sin cover) — et
  // sentrert cover-utsnitt kunne kutte vekk selve dyret når det ikke sitter
  // midt i bildet (tilbakemelding 2026-07-16, havørn-eksempelet: fuglen satt
  // høyt oppe i et høyt/portrettformat bilde, cover-utsnittet viste stort
  // sett himmel/gren). Samme resonnement som .cropImg, se wireCropInteraction.
  const bildeHtml = funn.bildeUrl
    ? `<img src="${window.ApiClient.bildeUrl(funn.id)}" class="detailImg" alt="">`
    : '';

  // Bygges fra funn.art.taxonId når den finnes (dekker ALLE funn, ikke bare
  // de 17 kuraterte artene i speciesCache — de aller fleste funn har nå en
  // taxonId uansett, siden både KI-forslag og artssøket alltid setter den).
  // s.artskartUrl er kun en reserveløsning for eldre funn uten taxonId der
  // arten tilfeldigvis er en av de kuraterte.
  const artskartUrl = funn.art?.taxonId
    ? `https://artskart.artsdatabanken.no/#taxon/${funn.art.taxonId}`
    : s.artskartUrl;

  el('detailContent').innerHTML = `
    ${bildeHtml}
    <h2>${escapeHtml(funn.art?.norsk || 'Ukjent art')}</h2>
    <p><em>${escapeHtml(funn.art?.latinsk || s.latinsk || '')}</em></p>
    ${rodlisteBadge(s.rodlisteNorge)}
    <div id="artsbeskrivelseWrap"></div>
    ${count ? `<p class="hint">Registrert ${count} ganger i nærheten før (Artskart).</p>` : ''}
    <p>Registrert: ${new Date(funn.tidspunkt).toLocaleString('no-NO')}${funn.registrertAv ? ' av ' + escapeHtml(funn.registrertAv) : ''}</p>
    ${artskartUrl ? `<a href="${escapeHtml(artskartUrl)}" target="_blank" rel="noopener">Se på Artsdatabanken →</a>` : ''}
    ${funn.erEgenRegistrering || funn.kanSlette ? `
      <div class="sheetActions">
        ${funn.erEgenRegistrering ? '<button id="redigerFunnBtn" class="secondaryBtn">Rediger</button>' : ''}
        ${funn.kanSlette ? '<button id="slettFunnBtn" class="secondaryBtn">Slett</button>' : ''}
      </div>
      <div id="redigerFunnForm" hidden></div>` : ''}`;
  toggleSheet('detailPanel', true);
  lastArtsbeskrivelse(funn);

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

// Hentes async ETTER at panelet allerede vises (ikke await'et i openDetail)
// — artsomtale er en ren visningsdetalj, ikke noe som skal forsinke at
// funndetaljene dukker opp. apentFunnId-sjekken luker ut et sent svar hvis
// brukeren rakk å åpne et annet funn før dette resultatet kom tilbake.
async function lastArtsbeskrivelse(funn){
  const wrap = el('artsbeskrivelseWrap');
  const taxonId = funn.art?.taxonId;
  if (!taxonId || !wrap) return;

  let resultat = artsbeskrivelseCache.get(taxonId);
  if (!resultat) {
    resultat = await window.ApiClient.hentArtsbeskrivelse(taxonId, funn.art.latinsk);
    artsbeskrivelseCache.set(taxonId, resultat);
  }
  if (apentFunnId !== funn.id) return;
  if (!wrap.isConnected || !resultat.beskrivelse) return;

  wrap.innerHTML = `
    <p>${escapeHtml(resultat.beskrivelse)}</p>
    ${resultat.kilde === 'wikipedia'
      ? `<p class="hint">Kilde: <a href="${escapeHtml(resultat.wikipediaUrl || '#')}" target="_blank" rel="noopener">Wikipedia</a></p>`
      : ''}`;
}

const REDIGERBARE_ARTSTYPER = ARTSTYPER;

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
    <button id="redigerVelgPosisjonBtn" type="button" class="secondaryBtn">📍 Velg posisjon i kart</button>
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
  el('redigerVelgPosisjonBtn').addEventListener('click', () => {
    // Samme mønster som pickPositionOnMap() for ny registrering — feltene
    // var tidligere kun rå tall-input, "klin umulig å flytte ved å endre
    // koordinat-verdier" (bruker-tilbakemelding 2026-07-16). Nålens
    // bubblingMouseEvents:false (map.js) sikrer at et klikk på en annen
    // nål ikke også når dette map.once('click', …) samtidig.
    if (!mapCtx) { showToast('Kartet er ikke tilgjengelig akkurat nå.'); return; }
    toggleSheet('detailPanel', false);
    showToast('Trykk i kartet der funnet skal flyttes til');
    mapCtx.map.once('click', (e) => {
      // Kan være null hvis brukeren rakk å klikke en annen nål i mellomtiden
      // (åpner det funnets detaljpanel og bygger redigerFunnForm om/vekk) —
      // se marker.on('click', …) i map.js.
      const latInput = el('redigerLat');
      const lonInput = el('redigerLon');
      if (!latInput || !lonInput) return;
      latInput.value = e.latlng.lat;
      lonInput.value = e.latlng.lng;
      toggleSheet('detailPanel', true);
    });
  });
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
  ['setupPanel','listPanel','detailPanel','registerPanel','accountPanel','adminPanel','sidePanel','inviterPanel','dashboardPanel'].forEach(other => {
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
