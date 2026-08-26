#!/usr/bin/env node
// Bygger to kandidatlister til KI-benchmarket (se artsgjenkjenning-analysen
// delt 2026-08-21) for å isolere effekten av ÉN konkret, evidensbasert
// endring: dagens KI-prompt vekter kun de 17 kuraterte artene i
// data/species.json mot lokal Artskart-frekvens (buildSpeciesHintList() i
// js/app.js) — men de 17 artene er nesten utelukkende fugl/sjøpattedyr/alge.
// NULL planter, NULL sopp, NULL insekter. Likevel er "plante" 61 % av alle
// registrerte funn (107/174, snitt-KI-konfidens 0,56 — nest lavest av alle
// artstyper). Kandidatlisten KI-en faktisk får se for et planteblide
// inneholder derfor i praksis ingen reelle planteforslag i det hele tatt.
//
// "Dagens" kandidatliste: nøyaktig buildSpeciesHintList()-logikken —
// kun de 17 kuraterte artene, plausibilitet = lokalt Artskart-antall.
//
// "Forbedret" kandidatliste: samme 17 pluss topp N reelt lokalt observerte
// arter PER ARTSTYPE fra bondoya-db/data/artskart-bondoya.json (13 694
// observasjoner, 283 arter — hele det 40 km-utvidede cachet, se
// konsept.md "Sjeldenhet"). Løser nøyaktig dekningshullet over uten å endre
// noe i selve KI-kallets format (fortsatt {norsk, latinsk, artstype,
// plausibilitet} — samme kontrakt buildPrompt() i ki-proxy allerede leser).
//
// Skriver:
//   scripts/benchmark/kandidatliste-dagens.json
//   scripts/benchmark/kandidatliste-forbedret.json
//
// Bruk:
//   cd worker/api
//   node scripts/bygg-kandidatlister.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slaOppTaxon } from './lib/artskart-taxon.mjs';

const HER = dirname(fileURLToPath(import.meta.url));
const SPECIES_JSON = join(HER, '..', '..', '..', 'data', 'species.json');
const ARTSKART_CACHE = join(HER, '..', '..', '..', '..', 'bondoya-db', 'data', 'artskart-bondoya.json');
const UTMAPPE = join(HER, 'benchmark');

// Totalt antall NYE (ikke-kuraterte) kandidater som legges til i den
// forbedrede listen, fordelt PROPORSJONALT med hvor ofte hver artstype
// faktisk forekommer blant appens 174 registrerte funn (spurt live under,
// se fordelFunnHistorikk()) — IKKE proporsjonalt med rå Artskart-
// observasjonsfrekvens. Dette er en bevisst korreksjon: en første versjon
// av dette skriptet sorterte kun på lokal observasjonsfrekvens, som viste
// seg dominert av systematisk marinbunn-kartlegging (leddorm/pigghud-arter
// med 150-170 registrerte observasjoner hver) — arter besøkende på Bondøya
// så godt som aldri fotograferer (0 av 174 historiske funn er leddorm).
// Uten denne korreksjonen ville "plante" (61 % av alle funn, og selve
// grunnen til at denne kandidatlisten bygges) fått færre nye kandidater enn
// leddorm/pigghud i den ferdige 20-slissede prompten.
const NYE_KANDIDATER_TOTALT = 30;
// Hevet fra 2 til 5 (i to steg) etter benchmark-funn 2026-08-21: MIN=2 ga
// pattedyr kun {oter, hjort} som nye kandidater — "rådyr" (10 lokale
// observasjoner, faktisk arten i 4/6 pattedyr-bilder i gullsettet) ble
// utelatt, mens "hjort" (26 observasjoner, aldri riktig svar i gullsettet)
// ble en sterk distraktor: KI byttet fra riktig "Rådyr" til feil "hjort" på
// ALLE fire bildene sammenlignet med dagens (uendret) prompt. Etter at
// MAKS_KANDIDATER_A_SLA_OPP ble hevet til å dekke alle 283 arter (se under)
// dukket to nye pattedyr-konkurrenter opp (gaupe/rødrev, 12 observasjoner
// hver) som fortsatt presset rådyr (10) ut ved MIN=4 — rådyr er nøyaktig
// nr. 5 av 5 ikke-kuraterte pattedyr-kandidater i lokal frekvens, så MIN=5
// er det minimum som faktisk garanterer at den er med.
const MIN_NYE_PER_ARTSTYPE = 5;
const MAKS_NYE_PER_ARTSTYPE = 10; // tak per type, så ingen enkelt type tar hele budsjettet
// Hvor mange av de mest observerte artene totalt som i det hele tatt
// vurderes/slås opp mot taxon-API-et. Satt til 300 (over de 283 unike
// artene som faktisk finnes i cachen) etter samme funn som over: forrige
// tak på 200 utelot "rådyr" FØR per-type-fordelingen i det hele tatt fikk
// vurdere den (rådyr rangerer som nr. 250 av 283 i rå observasjonsfrekvens
// — under 200-grensen, men fortsatt en reell, lokalt observert art som
// programmet uansett registrerer besøkende funn av). Med 300 slås alle
// arter i cachen opp, så per-type-budsjettet (over) er den eneste
// begrensningen igjen — mer forutsigbart enn to uavhengige kutt-punkter.
const MAKS_KANDIDATER_A_SLA_OPP = 300;

async function hentArtstypeFordelingFraFunn() {
  const { execFileSync } = await import('node:child_process');
  const raw = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'bondoya', '--remote', '--json', '--command',
    'SELECT artstype, COUNT(*) AS n FROM funn GROUP BY artstype',
  ], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  const start = raw.indexOf('[');
  const rader = JSON.parse(raw.slice(start))[0].results;
  const fordeling = {};
  for (const r of rader) fordeling[r.artstype] = r.n;
  return fordeling;
}

function lastKuraterteArter() {
  return JSON.parse(readFileSync(SPECIES_JSON, 'utf8'));
}

function tellLokaleObservasjonerPerTaxon() {
  const rader = JSON.parse(readFileSync(ARTSKART_CACHE, 'utf8'));
  const teller = new Map(); // taxonId -> antall
  for (const r of rader) {
    if (!r.taxonId) continue;
    teller.set(r.taxonId, (teller.get(r.taxonId) || 0) + 1);
  }
  return teller;
}

async function main() {
  mkdirSync(UTMAPPE, { recursive: true });

  const kuratert = lastKuraterteArter();
  const kuratertNorskSet = new Set(kuratert.map(s => s.norsk.toLowerCase()));

  const observasjonerPerTaxon = tellLokaleObservasjonerPerTaxon();
  console.log(`${observasjonerPerTaxon.size} unike arter (taxonId) i lokal Artskart-cache.`);

  // --- "Dagens" liste: uendret gjengivelse av buildSpeciesHintList() ---
  // Trenger norsk-navn-basert telling (slik produksjonskoden faktisk gjør
  // det — den matcher IKKE på taxonId, kun art-streng, se app.js).
  const rawObs = JSON.parse(readFileSync(ARTSKART_CACHE, 'utf8'));
  const tellingPerNorskNavn = new Map();
  for (const o of rawObs) {
    const navn = (o.art || '').toLowerCase();
    tellingPerNorskNavn.set(navn, (tellingPerNorskNavn.get(navn) || 0) + 1);
  }
  const dagensListe = kuratert
    .map(s => ({
      norsk: s.norsk, latinsk: s.latinsk, artstype: s.artstype,
      plausibilitet: tellingPerNorskNavn.get(s.norsk.toLowerCase()) || 0,
    }))
    .sort((a, b) => b.plausibilitet - a.plausibilitet);

  writeFileSync(join(UTMAPPE, 'kandidatliste-dagens.json'), JSON.stringify(dagensListe, null, 2));
  console.log(`\nDagens kandidatliste: ${dagensListe.length} arter (uendret — de 17 kuraterte).`);

  // --- "Forbedret" liste: dagens 17 + topp lokale arter per artstype ---
  const sortertTaxonId = [...observasjonerPerTaxon.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAKS_KANDIDATER_A_SLA_OPP);

  console.log(`\nSlår opp artstype/latinsk navn for topp ${sortertTaxonId.length} lokalt observerte arter…`);
  const nyeKandidater = [];
  let i = 0;
  for (const [taxonId, antall] of sortertTaxonId) {
    i++;
    const treff = await slaOppTaxon(taxonId);
    if (i % 20 === 0) console.log(`  ${i}/${sortertTaxonId.length}…`);
    if (!treff || !treff.norsk || !treff.latinsk) continue;
    if (kuratertNorskSet.has(treff.norsk.toLowerCase())) continue; // allerede dekket
    nyeKandidater.push({
      norsk: treff.norsk, latinsk: treff.latinsk, artstype: treff.artstype,
      plausibilitet: antall,
    });
  }

  // Fordel NYE_KANDIDATER_TOTALT proporsjonalt med hvor ofte hver artstype
  // faktisk forekommer i appens egen funn-historikk (se begrunnelse ved
  // NYE_KANDIDATER_TOTALT over) — ikke etter rå lokal observasjonsfrekvens.
  console.log('\nHenter artstype-fordeling fra funn-historikken (for vekting)…');
  const funnFordeling = await hentArtstypeFordelingFraFunn();
  const totalFunn = Object.values(funnFordeling).reduce((a, b) => a + b, 0);

  const perType = new Map();
  for (const k of nyeKandidater) {
    if (!perType.has(k.artstype)) perType.set(k.artstype, []);
    perType.get(k.artstype).push(k);
  }
  for (const liste of perType.values()) liste.sort((a, b) => b.plausibilitet - a.plausibilitet);

  const utvalgteNye = [];
  for (const [type, liste] of perType) {
    const andel = (funnFordeling[type] || 0) / totalFunn;
    const budsjett = Math.min(
      MAKS_NYE_PER_ARTSTYPE,
      Math.max(MIN_NYE_PER_ARTSTYPE, Math.round(NYE_KANDIDATER_TOTALT * andel))
    );
    utvalgteNye.push(...liste.slice(0, Math.min(budsjett, liste.length)));
  }

  const forbedretListe = [...dagensListe, ...utvalgteNye]
    .sort((a, b) => b.plausibilitet - a.plausibilitet);

  writeFileSync(join(UTMAPPE, 'kandidatliste-forbedret.json'), JSON.stringify(forbedretListe, null, 2));

  console.log(`\nForbedret kandidatliste: ${forbedretListe.length} arter (17 kuratert + ${utvalgteNye.length} nye fra lokal Artskart-frekvens).`);
  console.log('\nNye arter lagt til, per artstype:');
  const fordelingNye = {};
  for (const k of utvalgteNye) fordelingNye[k.artstype] = (fordelingNye[k.artstype] || 0) + 1;
  for (const [type, n] of Object.entries(fordelingNye).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} +${n}`);
  }
  console.log('\nNeste steg: node scripts/kjor-claude-benchmark.mjs (krever ANTHROPIC_API_KEY i miljøet)');
}

main();
