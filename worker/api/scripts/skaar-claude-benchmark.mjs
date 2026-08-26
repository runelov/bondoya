#!/usr/bin/env node
// Skårer resultatene fra kjor-claude-benchmark.mjs mot gullsettets fasit.
// Topp-1 (KI sin førstekandidat = fasitart) og topp-3 (fasitarten finnes
// et sted i de inntil 3 tilbudte kandidatene), per variant og brutt ned
// per artstype — se artsgjenkjenning-analysen for hvorfor akkurat "plante"
// og "sopp" er der forbedringen forventes å monne mest.
//
// Bruker sammeArt() (lib/artsmatch.mjs) — normalisert strengsammenligning
// med GBIF-basert synonymfallback, ikke ren streng-likhet. Lagt til
// 2026-08-21 etter samme funn som i Naturalis-sammenligningen: et par
// synonym-/slektsnavnavvik ble feilaktig telt som feilsvar av en ren
// strengsammenligning.
//
// Bruk:
//   cd worker/api
//   node scripts/skaar-claude-benchmark.mjs

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

async function topp1Og3(kandidater, fasitLatinsk) {
  if (!kandidater.length) return { topp1: false, topp3: false, gbif: false };
  const forsteSjekk = await sammeArt(kandidater[0].latinsk, fasitLatinsk);
  let topp3 = forsteSjekk.match;
  let gbifBrukt = forsteSjekk.likhet === 'gbif';
  if (!topp3) {
    for (const k of kandidater.slice(1, 3)) {
      const sjekk = await sammeArt(k.latinsk, fasitLatinsk);
      if (sjekk.match) { topp3 = true; if (sjekk.likhet === 'gbif') gbifBrukt = true; break; }
    }
  }
  return { topp1: forsteSjekk.match, topp3, gbif: gbifBrukt };
}

async function main() {
  const gullsett = lastJson(join(UTMAPPE, 'gullsett.json'));
  const resultater = lastJson(join(UTMAPPE, 'resultater.json'));

  const varianter = ['dagens', 'forbedret'];
  const skaar = {};
  for (const v of varianter) skaar[v] = { totalt: 0, topp1: 0, topp3: 0, perType: {} };

  const uenigheter = [];
  let parvis = 0;
  let nGbifReddet = 0;

  // VIKTIG: skårene under telles KUN for funn der begge varianter er
  // fullført (parvis sammenligning) — se historisk merknad i git-loggen:
  // å telle hver variants EGEN fullførte delmengde uavhengig av den andre
  // ga et misvisende bilde under en avbrutt kjøring (83 %/69 % på ulike
  // delmengder, mens de faktisk overlappende funnene var 100 % enige).
  for (const funn of gullsett) {
    const dRad = resultater[`${funn.id}:dagens`];
    const fRad = resultater[`${funn.id}:forbedret`];
    if (!dRad || !fRad || dRad.feil || fRad.feil) continue;
    parvis++;

    const perVariantTopp1 = {};

    for (const [v, r] of [['dagens', dRad], ['forbedret', fRad]]) {
      const kandidater = r.kandidater || [];
      const { topp1: treffTopp1, topp3: treffTopp3, gbif } = await topp1Og3(kandidater, funn.artLatinsk);
      if (gbif) nGbifReddet++;

      const s = skaar[v];
      s.totalt++;
      if (treffTopp1) s.topp1++;
      if (treffTopp3) s.topp3++;

      if (!s.perType[funn.artstype]) s.perType[funn.artstype] = { totalt: 0, topp1: 0, topp3: 0 };
      s.perType[funn.artstype].totalt++;
      if (treffTopp1) s.perType[funn.artstype].topp1++;
      if (treffTopp3) s.perType[funn.artstype].topp3++;

      perVariantTopp1[v] = { treff: treffTopp1, forslag: kandidater[0]?.norsk || '(ingen)' };
    }

    if (perVariantTopp1.dagens.treff !== perVariantTopp1.forbedret.treff) {
      uenigheter.push({
        id: funn.id, fasit: funn.artNorsk,
        dagens: perVariantTopp1.dagens, forbedret: perVariantTopp1.forbedret,
      });
    }
  }

  console.log(`Parvis sammenlignet: ${parvis}/${gullsett.length} funn (begge varianter fullført for disse).`);
  if (nGbifReddet) console.log(`(${nGbifReddet} treff reddet av GBIF-synonymoppslag.)`);
  console.log();

  function pst(n, total) { return total ? `${Math.round((n / total) * 100)}%` : '–'; }

  console.log('=== Totalt ===');
  console.log('Variant     N    Topp-1        Topp-3');
  for (const v of varianter) {
    const s = skaar[v];
    console.log(`${v.padEnd(11)} ${String(s.totalt).padEnd(4)} ${pst(s.topp1, s.totalt).padEnd(13)} ${pst(s.topp3, s.totalt)}`);
  }

  console.log('\n=== Per artstype (topp-1) ===');
  const alleTyper = new Set([...Object.keys(skaar.dagens.perType), ...Object.keys(skaar.forbedret.perType)]);
  console.log('Artstype       N    Dagens        Forbedret');
  for (const type of [...alleTyper].sort()) {
    const d = skaar.dagens.perType[type] || { totalt: 0, topp1: 0 };
    const f = skaar.forbedret.perType[type] || { totalt: 0, topp1: 0 };
    console.log(`${type.padEnd(15)} ${String(d.totalt).padEnd(4)} ${pst(d.topp1, d.totalt).padEnd(13)} ${pst(f.topp1, f.totalt)}`);
  }

  if (uenigheter.length) {
    console.log(`\n=== ${uenigheter.length} funn der variantene er uenige (topp-1 riktig/feil ulikt) ===`);
    for (const u of uenigheter) {
      console.log(`  #${u.id} fasit=${u.fasit} | dagens: ${u.dagens.treff ? '✓' : '✗'} (${u.dagens.forslag}) | forbedret: ${u.forbedret.treff ? '✓' : '✗'} (${u.forbedret.forslag})`);
    }
  }

  const antallKjort = Object.values(resultater).filter(r => !r.feil).length;
  const antallForventet = gullsett.length * varianter.length;
  if (antallKjort < antallForventet) {
    console.log(`\n(Merk: ${antallKjort}/${antallForventet} kall fullført ennå — tallene over er et delresultat. Kjør kjor-claude-benchmark.mjs på nytt for å fullføre.)`);
  }
}

main();
