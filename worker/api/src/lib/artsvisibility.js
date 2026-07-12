// Bevisst duplisering av synligForPublic-feltet i data/species.json (som
// kun frontend leser) — Workeren kan ikke stole på et frontend-oppgitt
// synlighetsflagg, og å importere en fil utenfor worker/api/ er en
// bygge-sti-avhengighet vi heller unngår. Denne listen erstattes av en
// D1-tabell den dagen admin-panelet "Arter & synlighet" (utsatt, se
// konsept.md) lar produkteier overstyre enkeltarter selv — hold den i sync
// med data/species.json manuelt frem til da.
const SKJULT_FOR_PUBLIC_TAXON_IDER = new Set([
  3491,   // Ærfugl (VU)
  3863,   // Storskarv (NT)
  3562,   // Teist (NT)
  203546, // Krykkje (EN)
  3624,   // Gråmåke (VU)
  3628,   // Fiskemåke (VU)
  203529, // Tjeld (NT)
]);

// Ukjent/manglende taxonId (f.eks. fritekst-registrerte arter) regnes som
// synlig som standard — matcher species.json sin egen standardverdi. Kun
// kjente rødlistede/sensitive arter skjules eksplisitt.
export function erSynligForPublic(taxonId) {
  if (!taxonId) return true;
  return !SKJULT_FOR_PUBLIC_TAXON_IDER.has(taxonId);
}
