// js/ki-client.js
// Klient for KI-artsgjenkjenning. Snakker med den lille Cloudflare Worker-
// proxyen (se worker/ki-proxy/) som skjuler selve AI-nøkkelen — denne filen
// vet ingenting om hvilken KI-motor som brukes bak proxyen, kun kontrakten
// (bilde inn, strukturerte kandidater ut). Det gjør det trivielt å bytte
// KI-motor (Claude-vision <-> iNaturalist CV) uten å røre resten av appen.

const KI_PROXY_URL_KEY = 'mittbondoya-ki-proxy-url';
const KONFIDENS_AUTO_TERSKEL = 0.75; // over dette: velg automatisk. Under: vis alternativer.

function getProxyUrl(){
  return localStorage.getItem(KI_PROXY_URL_KEY) || '';
}
function setProxyUrl(url){
  localStorage.setItem(KI_PROXY_URL_KEY, url);
}
function isConfigured(){
  return !!getProxyUrl();
}

// speciesHint: liste med { norsk, latinsk, artstype, plausibilitet } — bygget
// av app.js fra species.json + (hvis tilgjengelig) artskart-bondoya.json, se
// buildSpeciesHintList() der. Sendes med som kontekst til KI-motoren slik at
// den vektlegger stedsforankret plausibilitet (se konsept.md).
async function gjenkjenn(imageBlob, speciesHint){
  const url = getProxyUrl();
  if (!url) throw new Error('KI-proxy er ikke konfigurert.');

  const form = new FormData();
  form.append('bilde', imageBlob, 'funn.jpg');
  form.append('kandidater', JSON.stringify(speciesHint || []));

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`KI-proxy svarte ${res.status}: ${await res.text()}`);
  const data = await res.json();

  // Forventet svarformat fra proxyen:
  // { kandidater: [ { norsk, latinsk, artstype, konfidens }, ... ] } sortert
  // høyest konfidens først.
  const kandidater = data.kandidater || [];
  const beste = kandidater[0] || null;
  const autoVelg = !!beste && beste.konfidens >= KONFIDENS_AUTO_TERSKEL;
  return {
    beste: beste ? { art: { norsk: beste.norsk, latinsk: beste.latinsk }, konfidens: beste.konfidens, artstype: beste.artstype } : null,
    alternativer: kandidater.slice(0, 3),
    autoVelg
  };
}

window.KiClient = { getProxyUrl, setProxyUrl, isConfigured, gjenkjenn, KONFIDENS_AUTO_TERSKEL };
