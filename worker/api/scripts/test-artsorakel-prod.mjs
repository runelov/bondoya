#!/usr/bin/env node
// ⚠️ AVVIKLET, IKKE KJØR PÅ NYTT (2026-08-27) ⚠️
// Artsdatabanken har utstedt ekte tokens til Bondøya, ett for
// ai.test.artsdatabanken.no og ett for ai.artsdatabanken.no (produksjon),
// med en eksplisitt regel: all testing/analyse/vurdering skal gå mot
// TESTENDEPUNKTET, kun selve appen skal gå mot produksjon. Bruk
// test-artsorakel.mjs i stedet — dette scriptet her kalte
// PRODUKSJONSendepunktet med et token skrapet fra klientkoden, noe som
// ikke lenger er riktig fremgangsmåte nå som vi har en avtale. Filen
// beholdes kun som historisk referanse for resultatene den allerede har
// samlet inn (benchmark/resultater-artsorakel-prod.json).
//
// --- opprinnelig toppkommentar under, for kontekst ---
//
// Kjørte gullsettet (81 funn, samme sett som test-naturalis-nia.mjs) mot det
// EKTE Artsorakel-endepunktet (ai.artsdatabanken.no), for å sammenligne
// direkte med produksjonen brukere faktisk møter — ikke bare Naturalis sitt
// offentlige NIA-testendepunkt. Se "Artsgjenkjenning: veivalg"-notatet
// (seksjon "Stikkprøve mot selve produksjons-Artsorakelet") for bakgrunnen:
// en 2-bilders stikkprøve viste at testendepunktet og produksjon IKKE alltid
// er enige på samme bilde, så et større datasett er nødvendig før en
// beslutning kan tas på testendepunkt-tallene alene.
//
// Kontrakt funnet ved å lese den offentlige, minifiserte JS-bundlen til
// orakel.artsdatabanken.no (samme metode som å åpne DevTools og se hva
// "Choose images" faktisk trigger):
//   POST https://ai.artsdatabanken.no/identify
//   Authorization: Bearer <AI_TOKEN>   (hentet friskt fra env.js hver kjøring
//                                       — samme token enhver besøkendes
//                                       nettleser laster ned og bruker)
//   FormData: application="Artsorakel Web", image=<blob>
// Svarform identisk med NIA-testendepunktet: predictions[0].taxa.items.
//
// VIKTIG — dette er et UDOKUMENTERT Artsdatabanken-endepunkt, ikke en
// publisert, støttet API, og IKKE Naturalis sitt dedikerte testendepunkt
// (som eksplisitt tillater denne typen bruk, se test-naturalis-nia.mjs).
// Ingen kjent kvote eller rate-limit-policy — vær forsiktig:
//   - Kjør i små bolker (--maks, default 15), ikke alle 81 i én økt.
//   - Pause mellom hvert kall (DELAY_MS under) i stedet for å brenne
//     gjennom listen så fort som mulig.
//   - Stopp og vent til senere hvis du ser 429/"too many requests" eller
//     annen tydelig rate-limiting — ikke prøv å omgå den.
// Resumerbart akkurat som test-naturalis-nia.mjs — kjør kommandoen igjen
// senere for å fortsette der du slapp.
//
// Bruk:
//   cd worker/api
//   node scripts/test-artsorakel-prod.mjs --maks 15
//
// Skriver: scripts/benchmark/resultater-artsorakel-prod.json (resumerbar).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');
const RESULTAT_FIL = join(UTMAPPE, 'resultater-artsorakel-prod.json');
const ENV_URL = 'https://orakel.artsdatabanken.no/env.js';
const IDENTIFY_URL = 'https://ai.artsdatabanken.no/identify';

const ARGS = process.argv.slice(2);
const maksIdx = ARGS.indexOf('--maks');
const MAKS_PER_KJORING = maksIdx !== -1 ? parseInt(ARGS[maksIdx + 1], 10) : 15;
const DELAY_MS = 2500; // forsiktig pause mellom hvert kall — se toppkommentar

function lastJson(fil, fallback) {
  return existsSync(fil) ? JSON.parse(readFileSync(fil, 'utf8')) : fallback;
}
function lagre(resultater) {
  writeFileSync(RESULTAT_FIL, JSON.stringify(resultater, null, 2));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function hentToken() {
  const res = await fetch(ENV_URL);
  const tekst = await res.text();
  const m = tekst.match(/AI_TOKEN:\s*"([^"]+)"/);
  if (!m) throw new Error('Fant ikke AI_TOKEN i env.js: ' + tekst.slice(0, 200));
  return m[1];
}

async function identifiser(token, bildeSti) {
  const bytes = readFileSync(bildeSti);
  const form = new FormData();
  form.append('application', 'Artsorakel Web');
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'bilde.jpg');

  const res = await fetch(IDENTIFY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const tekst = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${tekst.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(tekst); } catch { throw new Error(`Uventet svar (ikke JSON): ${tekst.slice(0, 300)}`); }

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
  console.log(`Kjører maks ${MAKS_PER_KJORING} i denne økten, ${DELAY_MS}ms pause mellom hvert kall (udokumentert endepunkt — se toppkommentar).\n`);

  const token = await hentToken();
  const utvalg = gjenstaende.slice(0, MAKS_PER_KJORING);
  let ok = 0, feil = 0;
  for (const funn of utvalg) {
    const bildeSti = join(UTMAPPE, funn.bildeFil);
    if (!existsSync(bildeSti)) { console.log(`  #${funn.id}: bilde mangler.`); continue; }
    try {
      const kandidater = await identifiser(token, bildeSti);
      resultater[funn.id] = { funnId: funn.id, kandidater, feil: null };
      ok++;
      const topp = kandidater[0];
      console.log(`  #${funn.id} [fasit: ${funn.artNorsk}] → ${topp ? `${topp.latinsk} (${Math.round((topp.sannsynlighet || 0) * 100)}%)` : '(tomt svar)'}`);
    } catch (e) {
      resultater[funn.id] = { funnId: funn.id, kandidater: [], feil: e.message };
      feil++;
      console.log(`  #${funn.id} → FEIL: ${e.message}`);
      if (/429|too.?many.?requests|rate.?limit/i.test(e.message)) {
        console.log('\n  → Ser ut som rate-limiting. Stopper økten her — ikke prøv igjen med det samme, vent til senere.');
        lagre(resultater);
        break;
      }
    }
    lagre(resultater);
    await sleep(DELAY_MS);
  }

  const gjenstaende2 = gullsett.filter(f => !resultater[f.id] || resultater[f.id].feil).length;
  console.log(`\nFerdig denne økten: ${ok} nye, ${feil} feilet. ${gjenstaende2}/${gullsett.length} gjenstår totalt.`);
  if (gjenstaende2 > 0) {
    console.log('Kjør samme kommando igjen (evt. senere) for å fortsette.');
  } else {
    console.log('Alle funn forsøkt! Kjør scripts/skaar-artsorakel-prod-benchmark.mjs for skåring.');
  }
}

main();
