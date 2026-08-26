// Slår opp {latinsk, norsk, artstype, rodlistekategori} for en taxonId mot
// Artsdatabankens live taxon-API — samme endepunkt og samme
// utledArtstype()-logikk som `../src/lib/taxonomi.js` bruker i produksjon,
// men med et lokalt fil-cache lagt oppå siden dette skriptet typisk slår opp
// et par hundre taxonId-er om gangen (kandidatliste-bygging), noe
// produksjonskoden aldri gjør (der er det ett oppslag per lagret funn).
//
// Cache-fil: scripts/benchmark/taxon-cache.json — commit ikke denne (se
// .gitignore), den er kun til å spare gjentatte kall under iterasjon.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utledArtstype } from '../../src/lib/taxonomi.js';

const HER = dirname(fileURLToPath(import.meta.url));
const CACHE_FIL = join(HER, '..', 'benchmark', 'taxon-cache.json');
const ARTSKART_API = 'https://artskart.artsdatabanken.no/publicapi/api';

let cache = null;
function lastCache() {
  if (cache) return cache;
  if (existsSync(CACHE_FIL)) {
    cache = JSON.parse(readFileSync(CACHE_FIL, 'utf8'));
  } else {
    cache = {};
  }
  return cache;
}
function lagreCache() {
  mkdirSync(dirname(CACHE_FIL), { recursive: true });
  writeFileSync(CACHE_FIL, JSON.stringify(cache, null, 2));
}

// pause: enkel høflighet mot Artsdatabankens API ved mange oppslag på rad —
// ikke et dokumentert krav, men samme forsiktighet som fetch_artskart.py
// allerede praktiserer mot samme API.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function slaOppTaxon(taxonId, { pauseMs = 150 } = {}) {
  const c = lastCache();
  const key = String(taxonId);
  if (key in c) return c[key];

  try {
    const res = await fetch(`${ARTSKART_API}/taxon/${taxonId}`);
    if (!res.ok) { c[key] = null; lagreCache(); return null; }
    const taxon = await res.json();
    if (!taxon || !taxon.TaxonId) { c[key] = null; lagreCache(); return null; }
    const resultat = {
      taxonId: taxon.TaxonId,
      latinsk: taxon.ValidScientificName || null,
      norsk: taxon.PrefferedPopularname || null,
      artstype: utledArtstype(taxon),
    };
    c[key] = resultat;
    lagreCache();
    await sleep(pauseMs);
    return resultat;
  } catch {
    c[key] = null;
    lagreCache();
    return null;
  }
}
