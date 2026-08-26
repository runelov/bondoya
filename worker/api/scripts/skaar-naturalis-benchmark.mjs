#!/usr/bin/env node
// Skårer resultater fra test-naturalis-nia.mjs mot gullsettets fasit, og
// stiller dem opp mot dagens Claude-prompt (resultater.json, ":dagens") på
// de samme funnene — samme parvis-prinsipp som skaar-claude-benchmark.mjs
// (kun funn der BEGGE kilder faktisk har svart telles med).
//
// Bruker sammeArt() (lib/artsmatch.mjs) — normalisert strengsammenligning
// med GBIF-basert synonymfallback — IKKE ren streng-likhet. Nødvendig
// oppdaget 2026-08-21: flere av Naturalis' svar ble feilaktig telt som
// gale fordi de brukte en annen (like gyldig) slektsnavnkonvensjon enn
// Artsdatabanken-navnet lagret som fasit (f.eks. "Chamaenerion" vs.
// "Chamerion angustifolium" — samme art).
//
// Bruk:
//   cd worker/api
//   node scripts/skaar-naturalis-benchmark.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sammeArt } from './lib/artsmatch.mjs';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');

function lastJson(fil) {
  if (!existsSync(fil)) { console.error(`Mangler ${fil}`); process.exit(1); }
  return JSON.parse(readFileSync(fil, 'utf8'));
}

async function main() {
  const gullsett = lastJson(join(UTMAPPE, 'gullsett.json'));
  const naturalisRes = lastJson(join(UTMAPPE, 'resultater-naturalis.json'));
  const claudeResFil = join(UTMAPPE, 'resultater.json');
  const claudeRes = existsSync(claudeResFil) ? JSON.parse(readFileSync(claudeResFil, 'utf8')) : {};

  let nTotalt = 0, nTopp1 = 0, nTopp3 = 0, nGbifReddet = 0;
  let parvisN = 0, parvisNaturalisTopp1 = 0, parvisClaudeTopp1 = 0;
  const perType = {};
  const uenigheter = [];

  for (const funn of gullsett) {
    const n = naturalisRes[funn.id];
    if (!n || n.feil) continue;
    nTotalt++;
    const kandidater = n.kandidater || [];

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
    if (dRad && !dRad.feil) {
      parvisN++;
      const dTopp1 = dRad.kandidater[0] ? (await sammeArt(dRad.kandidater[0].latinsk, funn.artLatinsk)).match : false;
      if (topp1) parvisNaturalisTopp1++;
      if (dTopp1) parvisClaudeTopp1++;
      if (topp1 !== dTopp1) {
        uenigheter.push({
          id: funn.id, fasit: funn.artNorsk,
          claude: { treff: dTopp1, forslag: dRad.kandidater[0]?.norsk || '(ingen)' },
          naturalis: { treff: topp1, forslag: kandidater[0]?.latinsk || '(ingen)' },
        });
      }
    }
  }

  function pst(n, total) { return total ? `${Math.round((n / total) * 100)}%` : '–'; }

  console.log(`Naturalis NIA forsøkt/besvart: ${nTotalt}/${gullsett.length} funn.`);
  if (nGbifReddet) console.log(`(${nGbifReddet} treff reddet av GBIF-synonymoppslag — hadde blitt feilaktig telt som feil ved ren strengsammenligning.)`);
  console.log();
  console.log('=== Naturalis alene ===');
  console.log(`Topp-1: ${nTopp1}/${nTotalt} (${pst(nTopp1, nTotalt)})`);
  console.log(`Topp-3: ${nTopp3}/${nTotalt} (${pst(nTopp3, nTotalt)})`);

  console.log('\n=== Per artstype (topp-1) ===');
  for (const [type, s] of Object.entries(perType).sort((a, b) => b[1].totalt - a[1].totalt)) {
    console.log(`  ${type.padEnd(12)} ${String(s.totalt).padEnd(4)} ${pst(s.topp1, s.totalt)}`);
  }

  console.log(`\n=== Parvis mot dagens Claude-prompt (${parvisN} funn der begge har svart) ===`);
  console.log(`Claude (dagens):  ${parvisClaudeTopp1}/${parvisN} (${pst(parvisClaudeTopp1, parvisN)})`);
  console.log(`Naturalis NIA:    ${parvisNaturalisTopp1}/${parvisN} (${pst(parvisNaturalisTopp1, parvisN)})`);

  if (uenigheter.length) {
    console.log(`\n=== ${uenigheter.length} funn der Claude og Naturalis er uenige om topp-1 riktig/feil ===`);
    for (const u of uenigheter) {
      console.log(`  #${u.id} fasit=${u.fasit} | Claude: ${u.claude.treff ? '✓' : '✗'} (${u.claude.forslag}) | Naturalis: ${u.naturalis.treff ? '✓' : '✗'} (${u.naturalis.forslag})`);
    }
  }

  if (nTotalt < gullsett.length) {
    console.log(`\n(${gullsett.length - nTotalt} funn gjenstår — kjør test-naturalis-nia.mjs igjen, maks ~8-10/dag.)`);
  }
}

main();
