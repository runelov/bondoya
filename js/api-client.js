// js/api-client.js
// Klient for bondoya-api-workeren (auth + funn-CRUD). I motsetning til
// KiClient/GhStore er dette IKKE brukerkonfigurerbart — alle brukere deler
// samme backend, så URL-en er fast. Lokalt (127.0.0.1/localhost) pekes det
// mot `wrangler dev` sin port i stedet for produksjons-hostnavnet.
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8787'
  : 'https://api.bondoya.no';

async function kall(sti, opts) {
  const res = await fetch(`${API_BASE}${sti}`, { credentials: 'include', ...opts });
  return res;
}

// Returnerer innlogget bruker ({epost, kortnavn, rolle}), eller null hvis
// ikke innlogget. Kastes bevisst ikke som feil — 401 er en normal, forventet
// tilstand (f.eks. ved appstart før innlogging), ikke en unntakssituasjon.
async function meg() {
  const res = await kall('/meg');
  if (!res.ok) return null;
  return res.json();
}

async function beOmLenke(epost, turnstileToken) {
  const res = await kall('/auth/be-om-lenke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epost, turnstileToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Uventet feil (${res.status}).`);
  return data;
}

async function loggUt() {
  await kall('/auth/logg-ut', { method: 'POST' });
}

async function hentFunn() {
  const res = await kall('/funn');
  if (!res.ok) throw new Error(`Kunne ikke hente funn (${res.status}).`);
  return res.json();
}

// Uinnlogget-vennlig: ingen credentials nødvendig, men skader ikke å bruke
// samme fetch-wrapper som resten av klienten.
async function hentOffentligeFunn() {
  const res = await kall('/funn/offentlig');
  if (!res.ok) throw new Error(`Kunne ikke hente funn (${res.status}).`);
  return res.json();
}

// Ett boolsk flagg (ingen funn-data) — brukes til å avgjøre om
// funnliste-knapp/kartmarkører skal vises for uinnloggede, FØR appen i det
// hele tatt spør om selve funn-dataene.
async function hentOffentligInnstillinger() {
  const res = await kall('/offentlig/innstillinger');
  if (!res.ok) throw new Error(`Kunne ikke hente innstillinger (${res.status}).`);
  return res.json();
}

// entry: samme felt-shape som appen bruker internt i dag ({art, artstype,
// lat, lon, tidspunkt, imageBlob, kiKonfidens?, kiAlternativer?}) — bygger
// om til multipart/form-data-feltnavnene Workeren forventer.
async function opprettFunn(entry) {
  const form = new FormData();
  form.append('art_norsk', entry.art.norsk);
  if (entry.art.latinsk) form.append('art_latinsk', entry.art.latinsk);
  if (entry.art.taxonId) form.append('art_taxon_id', String(entry.art.taxonId));
  form.append('artstype', entry.artstype);
  form.append('lat', String(entry.lat));
  form.append('lon', String(entry.lon));
  form.append('tidspunkt', entry.tidspunkt);
  if (entry.kiKonfidens) form.append('ki_konfidens', String(entry.kiKonfidens));
  if (entry.kiAlternativer) form.append('ki_alternativer', JSON.stringify(entry.kiAlternativer));
  if (entry.imageBlob) form.append('bilde', entry.imageBlob, 'funn.jpg');

  const res = await kall('/funn', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke lagre funnet (${res.status}).`);
  return data;
}

async function oppdaterFunn(id, felter) {
  const res = await kall(`/funn/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(felter),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke oppdatere funnet (${res.status}).`);
  return data;
}

async function slettFunn(id) {
  const res = await kall(`/funn/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Kunne ikke slette funnet (${res.status}).`);
  }
}

async function hentBrukere() {
  const res = await kall('/admin/brukere');
  if (!res.ok) throw new Error(`Kunne ikke hente brukerliste (${res.status}).`);
  return res.json();
}

async function settBrukerStatus(id, status) {
  const res = await kall(`/admin/brukere/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke oppdatere bruker (${res.status}).`);
  return data;
}

async function slettBrukerPermanent(id) {
  const res = await kall(`/admin/brukere/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke slette bruker (${res.status}).`);
  return data;
}

async function hentAdminInnstillinger() {
  const res = await kall('/admin/innstillinger');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke hente innstillinger (${res.status}).`);
  return data;
}

async function settAdminInnstillinger(felter) {
  const res = await kall('/admin/innstillinger', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(felter),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke oppdatere innstillinger (${res.status}).`);
  return data;
}

// Uinnlogget-vennlig, samme myke-sesjonssjekk-prinsipp som routes/sider.js —
// backend avgjør selv hva som er synlig ut fra ev. gyldig sesjonscookie.
async function hentSider() {
  const res = await kall('/sider');
  if (!res.ok) throw new Error(`Kunne ikke hente sider (${res.status}).`);
  return res.json();
}

async function hentSide(slug) {
  const res = await kall(`/sider/${slug}`);
  if (!res.ok) throw new Error(`Fant ikke siden (${res.status}).`);
  return res.json();
}

async function hentAdminSider() {
  const res = await kall('/admin/sider');
  if (!res.ok) throw new Error(`Kunne ikke hente sider (${res.status}).`);
  return res.json();
}

async function opprettSide(felter) {
  const res = await kall('/admin/sider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(felter),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke opprette siden (${res.status}).`);
  return data;
}

async function oppdaterSide(id, felter) {
  const res = await kall(`/admin/sider/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(felter),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Kunne ikke oppdatere siden (${res.status}).`);
  return data;
}

async function slettSide(id) {
  const res = await kall(`/admin/sider/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Kunne ikke slette siden (${res.status}).`);
  }
}

// Bildet vises via <img src="...">, ikke fetch+blob: sesjonscookien er
// SameSite=Lax og bondoya.no→api.bondoya.no er samme site (ulikt opphav),
// så den sendes automatisk med et vanlig <img>-kall — samme resonnement som
// fetch()-kallenes credentials:'include' i Milestone A-planen.
function bildeUrl(id) {
  return `${API_BASE}/funn/bilde/${id}`;
}

// Brukes av map.js til å bygge Leaflet-flismalen — samme same-site
// cookie-resonnement som bildeUrl() over, se lib/tiles.js-proxyen.
function flisUrlMal() {
  return `${API_BASE}/tiles/{z}/{x}/{y}`;
}

window.ApiClient = {
  meg,
  beOmLenke,
  loggUt,
  hentFunn,
  hentOffentligeFunn,
  hentOffentligInnstillinger,
  opprettFunn,
  oppdaterFunn,
  slettFunn,
  bildeUrl,
  flisUrlMal,
  hentBrukere,
  settBrukerStatus,
  slettBrukerPermanent,
  hentAdminInnstillinger,
  settAdminInnstillinger,
  hentSider,
  hentSide,
  hentAdminSider,
  opprettSide,
  oppdaterSide,
  slettSide,
};
