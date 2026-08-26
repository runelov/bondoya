// Løser et vitenskapelig navn til GBIFs kanoniske "speciesKey" via det
// gratis, autentiseringsfrie species/match-endepunktet — brukt til å
// sammenligne artsnavn på tvers av kilder som bruker ulik taksonomisk
// konvensjon (f.eks. slekt-omplassering: "Chamerion angustifolium" vs.
// "Chamaenerion angustifolium" er SAMME art, GBIF løser begge til
// speciesKey 6428353 — bekreftet live 2026-08-21 under Naturalis-
// benchmarket, der en ren streng-sammenligning av latinske navn
// feilaktig talte flere korrekte Naturalis-svar som feil).
//
// Kun "speciesKey" (ikke "usageKey", som kan peke til selve synonym-
// oppføringen fremfor den aksepterte arten) brukes som
// sammenligningsnøkkel — verifisert å være stabil på tvers av synonym-
// og akseptert-oppføring for samme art.
//
// Lokalt fil-cache (scripts/benchmark/gbif-cache.json) siden et fullt
// benchmark slår opp samme artsnavn om og om igjen (fasit gjentas per
// KI-motor som testes).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const CACHE_FIL = join(HER, '..', 'benchmark', 'gbif-cache.json');

let cache = null;
function lastCache() {
  if (cache) return cache;
  cache = existsSync(CACHE_FIL) ? JSON.parse(readFileSync(CACHE_FIL, 'utf8')) : {};
  return cache;
}
function lagreCache() {
  mkdirSync(dirname(CACHE_FIL), { recursive: true });
  writeFileSync(CACHE_FIL, JSON.stringify(cache, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returnerer GBIF speciesKey (number) eller null hvis navnet ikke lot seg
// slå opp med rimelig tillit. Krever EXACT match eller confidence ≥ 90 —
// unngår at en løs fuzzy-match på et helt annet slektsnavn feilaktig teller
// to ulike arter som like.
//
// VIKTIG: aksepterer IKKE bare rank=SPECIES — et navn med underart-tillegg
// UTEN et eksplisitt "subsp."-token (f.eks. "Bombus pascuorum sparreanus",
// som normaliserNavn() i artsmatch.mjs ikke fanger) løses av GBIF til
// rank=SUBSPECIES, men har likevel et korrekt speciesKey som peker til
// SAMME art-nivå som binomialet "Bombus pascuorum" — bekreftet live
// 2026-08-23 (begge → speciesKey 1340405). Et tidligere krav om
// rank==='SPECIES' her forkastet slike gyldige treff og telte Naturalis'
// riktige, bare mer presise, artsbestemmelse som feil.
export async function slaOppArtsnokkel(latinskNavn) {
  if (!latinskNavn) return null;
  const c = lastCache();
  const key = latinskNavn.trim().toLowerCase();
  if (key in c) return c[key];

  try {
    const res = await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(latinskNavn)}`);
    if (!res.ok) { c[key] = null; lagreCache(); return null; }
    const data = await res.json();
    const relevantRank = ['SPECIES', 'SUBSPECIES', 'VARIETY', 'FORM'].includes(data.rank);
    const godkjent = relevantRank && (data.matchType === 'EXACT' || (data.confidence || 0) >= 90);
    const resultat = godkjent ? (data.speciesKey ?? null) : null;
    c[key] = resultat;
    lagreCache();
    await sleep(100); // høflig mot GBIF sitt gratis API
    return resultat;
  } catch {
    c[key] = null;
    lagreCache();
    return null;
  }
}
