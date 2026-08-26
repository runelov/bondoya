#!/usr/bin/env node
// Bygger et "gullsett" for å benchmarke artsgjenkjenning (Claude vision vs.
// Naturalis' Nature Identification API, se artsgjenkjenning-analysen delt
// 2026-08-21) — alle funn som har et REELT artssøk-forankret taxonId
// (art_taxon_id IS NOT NULL, i dag 81/174), altså en art brukeren bevisst
// har valgt fra Artsdatabanken-søk, ikke bare akseptert KI sitt førstevalg
// uten å sjekke. Se seksjon "Datagrunnlag / Spor B" i analysen for
// resonnementet — dette gir en tryggere fasit enn å bruke KI sin egen
// topp-1-kandidat som fasit (det ville jukset til fordel for KI-en som
// testes).
//
// Skriver:
//   scripts/benchmark/gullsett.json        — metadata per funn (fasit +
//                                             historisk KI-kandidatliste)
//   scripts/benchmark/bilder/<id>.jpg       — feltbildet, hentet fra R2
//
// Idempotent — kjør på nytt for å plukke opp nye funn; hopper over bilder
// som allerede er lastet ned. Ingenting skrives til D1/R2, kun lokale
// filer (gitignored, se ../../.gitignore).
//
// Bruk:
//   cd worker/api
//   node scripts/eksporter-benchmark-sett.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');
const BILDEMAPPE = join(UTMAPPE, 'bilder');

function hentGullsettRader() {
  const raw = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'bondoya', '--remote', '--json', '--command',
    `SELECT id, art_norsk, art_latinsk, artstype, art_taxon_id, ki_konfidens,
            ki_alternativer, bilde_r2_key, tidspunkt
     FROM funn
     WHERE art_taxon_id IS NOT NULL AND bilde_r2_key IS NOT NULL
     ORDER BY id`,
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const start = raw.indexOf('[');
  const data = JSON.parse(raw.slice(start));
  return data[0].results;
}

function lastNedBilde(id, r2Key) {
  const mal = join(BILDEMAPPE, `${id}.jpg`);
  if (existsSync(mal)) return mal; // allerede hentet — spar et R2-kall
  execFileSync('npx', [
    'wrangler', 'r2', 'object', 'get', `bondoya-bilder/${r2Key}`,
    '--file', mal, '--remote',
  ], { stdio: 'inherit' });
  return mal;
}

mkdirSync(BILDEMAPPE, { recursive: true });

const rader = hentGullsettRader();
console.log(`${rader.length} funn kvalifiserer til gullsettet (har reelt taxonId + bilde).\n`);

const gullsett = [];
for (const r of rader) {
  console.log(`Henter bilde for funn #${r.id} — ${r.art_norsk} (${r.art_latinsk})…`);
  lastNedBilde(r.id, r.bilde_r2_key);
  gullsett.push({
    id: r.id,
    artNorsk: r.art_norsk,
    artLatinsk: r.art_latinsk,
    artstype: r.artstype,
    artTaxonId: r.art_taxon_id,
    kiKonfidensHistorisk: r.ki_konfidens,
    kiAlternativerHistorisk: r.ki_alternativer ? JSON.parse(r.ki_alternativer) : [],
    tidspunkt: r.tidspunkt,
    bildeFil: `bilder/${r.id}.jpg`,
  });
}

writeFileSync(join(UTMAPPE, 'gullsett.json'), JSON.stringify(gullsett, null, 2));

console.log(`\nFerdig. ${gullsett.length} bilder i scripts/benchmark/bilder/,`);
console.log('fasitliste i scripts/benchmark/gullsett.json.');
console.log('\nArtstype-fordeling i gullsettet:');
const fordeling = {};
for (const g of gullsett) fordeling[g.artstype] = (fordeling[g.artstype] || 0) + 1;
for (const [type, n] of Object.entries(fordeling).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(12)} ${n}`);
}
console.log('\nNeste steg: node scripts/test-naturalis-nia.mjs --maks 10');
