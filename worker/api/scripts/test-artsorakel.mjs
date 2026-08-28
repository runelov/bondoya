#!/usr/bin/env node
// Kjører gullsettet mot Artsdatabankens OFFISIELLE testendepunkt for
// Artsorakel-motoren, med et ekte token utstedt til Bondøya av
// Artsdatabanken selv (2026-08-27, etter henvendelse — se
// bondoya-artsdatabanken-outreach.md). Erstatter
// test-artsorakel-prod.mjs, som brukte et token skrapet fra
// orakel.artsdatabanken.no sin klientkode mot selve PRODUKSJONSENDEPUNKTET
// — det var greit for et lite, tempo-begrenset engangsbenchmark før vi
// hadde en avtale, men er ikke riktig fremgangsmåte nå.
//
// VIKTIG REGEL fra Artsdatabanken (eksplisitt instruks 2026-08-27): all
// testing/analyse/vurdering skal gå mot TESTENDEPUNKTET
// (ai.test.artsdatabanken.no). KUN selve appen (worker/ki-proxy sin
// fremtidige produksjonsintegrasjon) skal gå mot ai.artsdatabanken.no.
// Dette scriptet bruker derfor UTELUKKENDE 'test'-tokenet fra
// benchmark/artsorakel-tokens.local.json — aldri 'prod'-verdien i den
// filen. Ikke endre ENDEPUNKT under uten å sjekke med Artsdatabanken
// først.
//
// Kontrakt: samme som tidligere avdekket for produksjonsendepunktet
// (POST /identify, multipart image, Bearer-token) — testendepunktet
// antas å følge samme kontrakt siden det er samme APIfamilie, men er
// ikke eksplisitt dokumentert oss ennå. Verifiser med ett bilde først
// hvis noe virker galt.
//
// Bruk:
//   cd worker/api
//   node scripts/test-artsorakel.mjs --maks 20
//
// Skriver: scripts/benchmark/resultater-artsorakel-test.json (resumerbar).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');
const RESULTAT_FIL = join(UTMAPPE, 'resultater-artsorakel-test.json');
const TOKEN_FIL = join(UTMAPPE, 'artsorakel-tokens.local.json');
const ENDEPUNKT = 'https://ai.test.artsdatabanken.no/identify';

const ARGS = process.argv.slice(2);
const maksIdx = ARGS.indexOf('--maks');
const MAKS_PER_KJORING = maksIdx !== -1 ? parseInt(ARGS[maksIdx + 1], 10) : 20;
const DELAY_MS = 1500; // fortsatt en høflig pause, men mindre paranoid enn mot det udokumenterte endepunktet siden vi nå har et ekte, utstedt token

function lastJson(fil, fallback) {
  return existsSync(fil) ? JSON.parse(readFileSync(fil, 'utf8')) : fallback;
}
function lagre(resultater) {
  writeFileSync(RESULTAT_FIL, JSON.stringify(resultater, null, 2));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hentTestToken() {
  if (!existsSync(TOKEN_FIL)) {
    throw new Error(`Fant ikke ${TOKEN_FIL}. Se bondoya-artsdatabanken-outreach.md for tokens.`);
  }
  const data = JSON.parse(readFileSync(TOKEN_FIL, 'utf8'));
  if (!data.test) throw new Error(`Mangler "test"-token i ${TOKEN_FIL}.`);
  return data.test;
}

async function identifiser(token, bildeSti) {
  const bytes = readFileSync(bildeSti);
  const form = new FormData();
  form.append('application', 'Bondøya');
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'bilde.jpg');

  const res = await fetch(ENDEPUNKT, {
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
  const token = hentTestToken();

  const gjenstaende = gullsett.filter(f => !resultater[f.id] || resultater[f.id].feil);
  console.log(`${gullsett.length} funn totalt, ${gjenstaende.length} gjenstår.`);
  console.log(`Mot ${ENDEPUNKT} (offisielt testendepunkt, ekte token) — maks ${MAKS_PER_KJORING} denne økten.\n`);

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
      if (/429|too.?many.?requests|rate.?limit|401|403/i.test(e.message)) {
        console.log('\n  → Stopper økten her (rate-limit eller auth-feil) — sjekk tokenet før du prøver igjen.');
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
    console.log('Kjør samme kommando igjen for å fortsette.');
  } else {
    console.log('Alle funn forsøkt! Kjør scripts/skaar-artsorakel-benchmark.mjs for skåring.');
  }
}

main();
