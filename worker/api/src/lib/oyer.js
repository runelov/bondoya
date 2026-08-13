// Navngitte øy-/skjærpolygoner for Bondøya-området — erstatter den
// tidligere avstandsklyngingen i lib/fremdrift.js sin Øyhopper-beregning
// med ekte kystlinjegeometri fra OpenStreetMap. Se konsept.md "Øyhopper —
// landmasse-definisjon" og scripts/hent-oyer.mjs for hvordan
// data/oyer-bondoya.json ble generert (engangs/sjelden-kjørt, kystlinjer
// endrer seg ikke) — ikke rediger den filen for hånd, kjør scriptet på
// nytt hvis noe må endres.
import oyer from '../data/oyer-bondoya.json' with { type: 'json' };

// Standard ray-casting point-in-polygon (odd-even-regel) — polygon er en
// liste [lat, lon]-par, første og siste punkt er identiske (lukket ring,
// verifisert av hent-oyer.mjs ved generering).
function erPunktIPolygon(lat, lon, polygon) {
  let inne = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    const skjærer = (latI > lat) !== (latJ > lat) && lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI;
    if (skjærer) inne = !inne;
  }
  return inne;
}

// Finner hvilken kjent øy/skjær et punkt faller innenfor, eller null hvis
// det ikke treffer noen av de 27 kartlagte polygonene (upresis GPS helt
// ute ved en strand, eller genuint åpent hav) — ingen buffer/toleranse i
// v1, se plan-notatet 2026-08-13 for denne bevisste avgrensningen.
export function finnOy(lat, lon) {
  for (const oy of oyer) {
    if (erPunktIPolygon(lat, lon, oy.polygon)) return { id: oy.id, navn: oy.navn };
  }
  return null;
}
