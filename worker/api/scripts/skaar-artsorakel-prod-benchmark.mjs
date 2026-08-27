#!/usr/bin/env node
// Skårer resultater fra test-artsorakel-prod.mjs mot gullsettets fasit, og
// stiller dem opp mot BÅDE dagens Claude-prompt (resultater.json, ":dagens")
// OG Naturalis' NIA-testendepunkt (resultater-naturalis.json) på de samme
// funnene — tre-veis parvis-sammenligning, samme prinsipp som
// skaar-naturalis-benchmark.mjs (kun funn der alle sammenlignede kilder
// faktisk har svart telles med i de parvise tallene).
//
// Bruker sammeArt() (lib/artsmatch.mjs) — normalisert strengsammenligning
// med GBIF-basert synonymfallback, ikke ren streng-likhet (se
// skaar-naturalis-benchmark.mjs for hvorfor det er nødvendig).
//
// Bruk:
//   cd worker/api
//   node scripts/skaar-artsorakel-prod-benchmark.mjs

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
  const prodRes = lastJson(join(UTMAPPE, 'resultater-artsorakel-prod.json'));
  const naturalisRes = lastJson(join(UTMAPPE, 'resultater-naturalis.json'), {});
  const claudeRes = lastJson(join(UTMAPPE, 'resultater.json'), {});

  let nTotalt = 0, nTopp1 = 0, nTopp3 = 0, nGbifReddet = 0;
  const perType = {};
  let parvisN = 0, parvisProdTopp1 = 0, parvisClaudeTopp1 = 0, parvisNaturalisTopp1 = 0, parvisNMedNaturalis = 0;
  const uenigheter = [];

  for (const funn of gullsett) {
    const p = prodRes[funn.id];
    if (!p || p.feil) continue;
    nTotalt++;
    const kandidater = p.kandidater || [];

    const topp1Sjekk = kandidater[0] ? await sammeArt(kandidater[0].latinsk, funn.artLatinsk) : { match: false, likhet: 'ingen' };
    const topp1 = topp1Sjekk.match;
    if (topp1Sjekk.likhet === 'gbif') nGbifReddet++;
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
    const nRad = naturalisRes[funn.id];
    const claudeKlar = dRad && !dRad.feil;
    const naturalisKlar = nRad && !nRad.feil;

    if (claudeKlar) {
      parvisN++;
      const claudeTopp1 = dRad.kandidater[0] ? (await sammeArt(dRad.kandidater[0].latinsk, funn.artLatinsk)).match : false;
      if (topp1) parvisProdTopp1++;
      if (claudeTopp1) parvisClaudeTopp1++;

      let naturalisTopp1 = null;
      if (naturalisKlar) {
        parvisNMedNaturalis++;
        naturalisTopp1 = nRad.kandidater[0] ? (await sammeArt(nRad.kandidater[0].latinsk, funn.artLatinsk)).match : false;
        if (naturalisTopp1) parvisNaturalisTopp1++;
      }

      if (topp1 !== claudeTopp1 || (naturalisTopp1 !== null && topp1 !== naturalisTopp1)) {
        uenigheter.push({
          id: funn.id, fasit: funn.artNorsk,
          claude: { treff: claudeTopp1, forslag: dRad.kandidater[0]?.norsk || '(ingen)' },
          artsorakelProd: { treff: topp1, forslag: kandidater[0]?.latinsk || '(ingen)' },
          naturalisTest: naturalisKlar ? { treff: naturalisTopp1, forslag: nRad.kandidater[0]?.latinsk || '(ingen)' } : '(ikke testet)',
        });
      }
    }
  }

  function pst(n, total) { return total ? `${Math.round((n / total) * 100)}%` : '–'; }

  console.log(`\n=== Produksjons-Artsorakel (ai.artsdatabanken.no) — N=${nTotalt} av 81 ===`);
  console.log(`Topp-1: ${nTopp1}/${nTotalt} (${pst(nTopp1, nTotalt)})`);
  console.log(`Topp-3: ${nTopp3}/${nTotalt} (${pst(nTopp3, nTotalt)})`);
  console.log(`(${nGbifReddet} treff kun via GBIF-synonymfallback, ikke ren strenglikhet)`);

  console.log(`\nPer artstype:`);
  for (const [type, t] of Object.entries(perType).sort((a, b) => b[1].totalt - a[1].totalt)) {
    console.log(`  ${type.padEnd(14)} ${t.topp1}/${t.totalt} (${pst(t.topp1, t.totalt)})`);
  }

  console.log(`\n=== Parvis mot Claude (N=${parvisN}, kun funn begge har svart på) ===`);
  console.log(`Artsorakel-produksjon topp-1: ${parvisProdTopp1}/${parvisN} (${pst(parvisProdTopp1, parvisN)})`);
  console.log(`Claude (dagens prompt) topp-1: ${parvisClaudeTopp1}/${parvisN} (${pst(parvisClaudeTopp1, parvisN)})`);

  if (parvisNMedNaturalis > 0) {
    console.log(`\n=== Tre-veis, der Naturalis-testendepunktet også har svart (N=${parvisNMedNaturalis}) ===`);
    console.log(`Naturalis (testendepunkt) topp-1: ${parvisNaturalisTopp1}/${parvisNMedNaturalis} (${pst(parvisNaturalisTopp1, parvisNMedNaturalis)})`);
    console.log(`— sammenlign mot Artsorakel-produksjon og Claude sine tall over på samme delmengde for et rettferdig bilde av om test- og produksjonsendepunktet driver fra hverandre.`);
  }

  if (uenigheter.length) {
    console.log(`\n=== ${uenigheter.length} uenigheter (Claude vs. produksjons-Artsorakel, og evt. Naturalis-testendepunkt) ===`);
    for (const u of uenigheter) {
      console.log(`  #${u.id} [fasit: ${u.fasit}]`);
      console.log(`    Claude:            ${u.claude.treff ? '✓' : '✗'} ${u.claude.forslag}`);
      console.log(`    Artsorakel (prod): ${u.artsorakelProd.treff ? '✓' : '✗'} ${u.artsorakelProd.forslag}`);
      if (u.naturalisTest !== '(ikke testet)') {
        console.log(`    Naturalis (test):  ${u.naturalisTest.treff ? '✓' : '✗'} ${u.naturalisTest.forslag}`);
      }
    }
  }
}

main();
