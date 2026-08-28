#!/usr/bin/env node
// Skårer resultater fra test-artsorakel.mjs (offisielt testendepunkt, ekte
// token) mot gullsettets fasit, og stiller dem opp mot Claude
// (resultater.json, ":dagens"), Naturalis' NIA-testendepunkt
// (resultater-naturalis.json), OG det tidligere scrapede
// produksjons-datapunktet (resultater-artsorakel-prod.json, historisk —
// se test-artsorakel-prod.mjs sin deprecation-merknad) der det finnes, som
// en sanity-sjekk på at det offisielle testendepunktet gir sammenlignbare
// tall.
//
// Bruker sammeArt() (lib/artsmatch.mjs) — normalisert strengsammenligning
// med GBIF-basert synonymfallback.
//
// Bruk:
//   cd worker/api
//   node scripts/skaar-artsorakel-benchmark.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sammeArt } from './lib/artsmatch.mjs';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');

function lastJson(fil, fallback) {
  if (existsSync(fil)) return JSON.parse(readFileSync(fil, 'utf8'));
  if (fallback !== undefined) return fallback;
  console.error(`Mangler ${fil}`);
  process.exit(1);
}

async function main() {
  const gullsett = lastJson(join(UTMAPPE, 'gullsett.json'));
  const testRes = lastJson(join(UTMAPPE, 'resultater-artsorakel-test.json'));
  const prodScrapetRes = lastJson(join(UTMAPPE, 'resultater-artsorakel-prod.json'), {});
  const naturalisRes = lastJson(join(UTMAPPE, 'resultater-naturalis.json'), {});
  const claudeRes = lastJson(join(UTMAPPE, 'resultater.json'), {});

  let nTotalt = 0, nTopp1 = 0, nTopp3 = 0;
  const perType = {};
  let parvisN = 0, parvisTestTopp1 = 0, parvisClaudeTopp1 = 0;
  let nBeggeEndepunkt = 0, nEnigeEndepunkt = 0;

  for (const funn of gullsett) {
    const t = testRes[funn.id];
    if (!t || t.feil) continue;
    nTotalt++;
    const kandidater = t.kandidater || [];

    const topp1 = kandidater[0] ? (await sammeArt(kandidater[0].latinsk, funn.artLatinsk)).match : false;
    let topp3 = topp1;
    if (!topp3) {
      for (const k of kandidater.slice(0, 3)) {
        if ((await sammeArt(k.latinsk, funn.artLatinsk)).match) { topp3 = true; break; }
      }
    }
    if (topp1) nTopp1++;
    if (topp3) nTopp3++;

    if (!perType[funn.artstype]) perType[funn.artstype] = { totalt: 0, topp1: 0 };
    perType[funn.artstype].totalt++;
    if (topp1) perType[funn.artstype].topp1++;

    const dRad = claudeRes[`${funn.id}:dagens`];
    if (dRad && !dRad.feil) {
      parvisN++;
      const claudeTopp1 = dRad.kandidater[0] ? (await sammeArt(dRad.kandidater[0].latinsk, funn.artLatinsk)).match : false;
      if (topp1) parvisTestTopp1++;
      if (claudeTopp1) parvisClaudeTopp1++;
    }

    const pRad = prodScrapetRes[funn.id];
    if (pRad && !pRad.feil) {
      nBeggeEndepunkt++;
      const prodTopp1 = pRad.kandidater[0] ? (await sammeArt(pRad.kandidater[0].latinsk, funn.artLatinsk)).match : false;
      if (topp1 === prodTopp1) nEnigeEndepunkt++;
    }
  }

  function pst(n, total) { return total ? `${Math.round((n / total) * 100)}%` : '–'; }

  console.log(`\n=== Artsorakel, offisielt testendepunkt (ai.test.artsdatabanken.no) — N=${nTotalt} av 81 ===`);
  console.log(`Topp-1: ${nTopp1}/${nTotalt} (${pst(nTopp1, nTotalt)})`);
  console.log(`Topp-3: ${nTopp3}/${nTotalt} (${pst(nTopp3, nTotalt)})`);

  console.log(`\nPer artstype:`);
  for (const [type, t] of Object.entries(perType).sort((a, b) => b[1].totalt - a[1].totalt)) {
    console.log(`  ${type.padEnd(14)} ${t.topp1}/${t.totalt} (${pst(t.topp1, t.totalt)})`);
  }

  console.log(`\n=== Parvis mot Claude (N=${parvisN}) ===`);
  console.log(`Artsorakel (testendepunkt) topp-1: ${parvisTestTopp1}/${parvisN} (${pst(parvisTestTopp1, parvisN)})`);
  console.log(`Claude (dagens prompt) topp-1: ${parvisClaudeTopp1}/${parvisN} (${pst(parvisClaudeTopp1, parvisN)})`);

  if (nBeggeEndepunkt > 0) {
    console.log(`\n=== Sanity-sjekk: testendepunkt vs. det tidligere scrapede produksjonsdatapunktet (N=${nBeggeEndepunkt}) ===`);
    console.log(`Enige om topp-1-treff/bom: ${nEnigeEndepunkt}/${nBeggeEndepunkt} (${pst(nEnigeEndepunkt, nBeggeEndepunkt)})`);
    console.log(`— høy enighet her styrker tilliten til at testendepunktet er representativt for produksjon.`);
  }
}

main();
