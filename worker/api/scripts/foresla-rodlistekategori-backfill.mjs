#!/usr/bin/env node
// Foreslår rodlistekategori for eksisterende funn med kjent taxonId, men
// rodlistekategori = NULL — dvs. alle funn registrert før migrasjon 0017
// (2026-08-13). Se konsept.md "Rødlistekategori — løst, nær gratis".
//
// Skriver KUN forslag til stdout — oppdaterer ingenting i D1. Kjør
// UPDATE-setningene manuelt etter gjennomsyn, ett funn av gangen. Samme
// mønster og samme begrunnelse som foresla-taxonid-backfill.mjs (les den
// først) — automatisk skriving er bevisst unngått i denne kodebasen for
// alt som ikke er en syntaktisk validering.
//
// Bruk:
//   cd worker/api
//   node scripts/foresla-rodlistekategori-backfill.mjs
//
// Krever at `wrangler` er logget inn (samme tilgang som `npm run
// db:migrate:remote`) — henter radene via `wrangler d1 execute --remote`.

import { execFileSync } from 'node:child_process';
import { hentAutoritativArtstype } from '../src/lib/taxonomi.js';

function hentFunnUtenRodlistekategori() {
  const raw = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'bondoya', '--remote', '--json', '--command',
    'SELECT id, art_taxon_id FROM funn WHERE art_taxon_id IS NOT NULL AND rodlistekategori IS NULL ORDER BY id',
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const start = raw.indexOf('[');
  const data = JSON.parse(raw.slice(start));
  return data[0].results;
}

const funn = hentFunnUtenRodlistekategori();
console.log(`${funn.length} funn med kjent taxonId, men uten rodlistekategori.\n`);

for (const f of funn) {
  const treff = await hentAutoritativArtstype(f.art_taxon_id);
  if (!treff || !treff.rodlistekategori) {
    console.log(`--- funn #${f.id} (taxonId ${f.art_taxon_id}): ingen rødlistekategori (LC/DD/NA, eller oppslagsfeil) — ingen endring foreslått.\n`);
    continue;
  }
  console.log(`--- funn #${f.id} (taxonId ${f.art_taxon_id}): rodlistekategori "${treff.rodlistekategori}" ---`);
  console.log(`  Hvis riktig, kjør manuelt:`);
  console.log(`  npx wrangler d1 execute bondoya --remote --command "UPDATE funn SET rodlistekategori = '${treff.rodlistekategori}' WHERE id = ${f.id};"\n`);
}
