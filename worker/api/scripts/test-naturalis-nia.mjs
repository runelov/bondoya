#!/usr/bin/env node
// Kjører gullsettet mot Naturalis' offentlige "Nature Identification API"
// (NIA) testendepunkt — se "Artsgjenkjenning: veivalg"-analysen for hvorfor
// dette er en reell kandidat: samme modellfamilie som driver Artsdatabankens
// Artsorakel (orakel.artsdatabanken.no), men Naturalis driver selv et
// dokumentert, offentlig testendepunkt (multi-source.docs.biodiversity-
// analysis.eu) — noe CHANGELOG 0.9.27 sin undersøkelse av Artsdatabankens
// EGEN udokumenterte proxy (ai.artsdatabanken.no) ikke fant.
//
// VIKTIG — kvote: 10 identifikasjoner/dag, ANTATT PER IP-ADRESSE (ikke
// dokumentert eksplisitt av Naturalis, men eneste tekniske mulighet siden
// endepunktet er heltUANTENTISERT — se analysenotatet). Uten auth er IP det
// eneste serveren kan skille "brukere" på. Med 81 bilder i gullsettet tar
// en full kjøring derfor flere dager i småporsjoner à maks 10/dag — scriptet
// er resumerbart og respekterer --maks per kjøring nettopp derfor.
//
// Ingen autentisering, ingen hemmelighet å beskytte her — dette er et
// åpent, ratebegrenset testendepunkt.
//
// Bruk (kjør typisk én gang PER DAG, maks 10 om gangen):
//   cd worker/api
//   node scripts/test-naturalis-nia.mjs --maks 10
//
// Skriver: scripts/benchmark/resultater-naturalis.json (resumerbar —
// hopper over allerede vellykkede id-er).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');
const RESULTAT_FIL = join(UTMAPPE, 'resultater-naturalis.json');
const ENDEPUNKT = 'https://multi-source.identify.biodiversityanalysis.eu/v2/observation/identify';

const ARGS = process.argv.slice(2);
const maksIdx = ARGS.indexOf('--maks');
// Default 8, ikke 10 — liten sikkerhetsmargin under den dokumenterte
// dagsgrensen i tilfelle andre kall fra samme nett/IP samme dag (f.eks. en
// annen fane som åpner orakel.artsdatabanken.no, som muligens deler
// infrastruktur — ubekreftet, men billig å være forsiktig med).
const MAKS_PER_KJORING = maksIdx !== -1 ? parseInt(ARGS[maksIdx + 1], 10) : 8;

function lastJson(fil, fallback) {
  return existsSync(fil) ? JSON.parse(readFileSync(fil, 'utf8')) : fallback;
}
function lagre(resultater) {
  writeFileSync(RESULTAT_FIL, JSON.stringify(resultater, null, 2));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function identifiser(bildeSti) {
  const bytes = readFileSync(bildeSti);
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'bilde.jpg');

  const res = await fetch(ENDEPUNKT, { method: 'POST', body: form });
  const tekst = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${tekst.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(tekst); } catch { throw new Error(`Uventet svar (ikke JSON): ${tekst.slice(0, 300)}`); }

  // Responsform (se multi-source.docs.biodiversityanalysis.eu/examples/public_endpoint/):
  // { predictions: [{ taxa: { items: [{ scientific_name, probability, ... }] } }], ... }
  const items = data?.predictions?.[0]?.taxa?.items || [];
  return items.map(i => ({ latinsk: i.scientific_name, sannsynlighet: i.probability }));
}

async function main() {
  const gullsett = lastJson(join(UTMAPPE, 'gullsett.json'), null);
  if (!gullsett) {
    console.error('Fant ikke gullsett.json — kjør eksporter-benchmark-sett.mjs først.');
    process.exit(1);
  }
  const resultater = lastJson(RESULTAT_FIL, {});

  const gjenstaende = gullsett.filter(f => !resultater[f.id] || resultater[f.id].feil);
  console.log(`${gullsett.length} funn totalt, ${gjenstaende.length} gjenstår (ikke forsøkt ennå, eller feilet sist).`);
  console.log(`Kjører maks ${MAKS_PER_KJORING} i denne økten (dagskvote, antatt IP-basert — se toppkommentar).\n`);

  const utvalg = gjenstaende.slice(0, MAKS_PER_KJORING);
  let ok = 0, feil = 0;
  for (const funn of utvalg) {
    const bildeSti = join(UTMAPPE, funn.bildeFil);
    if (!existsSync(bildeSti)) { console.log(`  #${funn.id}: bilde mangler.`); continue; }
    try {
      const kandidater = await identifiser(bildeSti);
      resultater[funn.id] = { funnId: funn.id, kandidater, feil: null };
      ok++;
      const topp = kandidater[0];
      console.log(`  #${funn.id} [fasit: ${funn.artNorsk}] → ${topp ? `${topp.latinsk} (${Math.round((topp.sannsynlighet || 0) * 100)}%)` : '(tomt svar)'}`);
    } catch (e) {
      resultater[funn.id] = { funnId: funn.id, kandidater: [], feil: e.message };
      feil++;
      console.log(`  #${funn.id} → FEIL: ${e.message}`);
      // En feil midt i økten er ofte nettopp dagskvoten som er brukt opp —
      // gi tydelig beskjed og stopp resten av økten i stedet for å brenne
      // gjennom feil på alle gjenværende bilder.
      if (/429|quota|rate.?limit/i.test(e.message)) {
        console.log('\n  → Ser ut som dagskvoten er brukt opp. Stopper økten her, prøv igjen i morgen.');
        lagre(resultater);
        break;
      }
    }
    lagre(resultater);
    await sleep(1000);
  }

  const gjenstaaende2 = gullsett.filter(f => !resultater[f.id] || resultater[f.id].feil).length;
  console.log(`\nFerdig denne økten: ${ok} nye, ${feil} feilet. ${gjenstaaende2}/${gullsett.length} gjenstår totalt.`);
  if (gjenstaaende2 > 0) {
    console.log('Kjør samme kommando igjen i morgen (eller senere) for å fortsette.');
  } else {
    console.log('Alle funn forsøkt! Neste steg: skår resultatet (be Claude om det, eller se skaar-naturalis-benchmark.mjs om den finnes).');
  }
}

main();
