// Delt "er dette samme art"-sammenligning for alle skår-skriptene.
// Rask sti: normalisert streng-likhet (dekker de aller fleste tilfellene,
// ingen nettverkskall). Fallback: GBIF speciesKey-oppslag (se
// gbif-taxon.mjs) for å fange synonymer/slekt-omplasseringer en ren
// strengsammenligning feilaktig teller som avvik (bekreftet nødvendig
// 2026-08-21: "Chamerion angustifolium" vs. "Chamaenerion angustifolium",
// samme art, ulik slektsnavnkonvensjon).

import { slaOppArtsnokkel } from './gbif-taxon.mjs';

export function normaliserNavn(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*\(.*\)\s*$/, '')       // "... (usikker, ikke i lokal liste)" o.l.
    .replace(/\s+subsp\.?\s+\S+$/, '')  // underart-kvalifikator
    .replace(/\s+var\.?\s+\S+$/, '')    // varietet-kvalifikator
    .trim();
}

// Returnerer { likhet: 'streng' | 'gbif' | 'ingen', match: boolean }
export async function sammeArt(latinskA, latinskB) {
  const a = normaliserNavn(latinskA);
  const b = normaliserNavn(latinskB);
  if (!a || !b) return { likhet: 'ingen', match: false };
  if (a === b) return { likhet: 'streng', match: true };

  const [nokkelA, nokkelB] = await Promise.all([slaOppArtsnokkel(latinskA), slaOppArtsnokkel(latinskB)]);
  if (nokkelA != null && nokkelB != null && nokkelA === nokkelB) {
    return { likhet: 'gbif', match: true };
  }
  return { likhet: 'ingen', match: false };
}
