// Reserveløsning for artsomtale når ingen admin har skrevet en (se
// arter_metadata i migrations/0015 og hentArtsbeskrivelse i routes/arter.js).
// Artsdatabankens taxon-API har ingen fritekstbeskrivelse i det hele tatt
// (bekreftet 2026-07-16 mot faktisk respons) — Wikipedia er derfor primær
// kilde til prosa, ikke Artsdatabanken.
//
// Det latinske navnet fungerer overraskende pålitelig som sidetittel også på
// norsk Wikipedia: artsartikler er nesten alltid tilgjengelige via en
// redirect fra det vitenskapelige navnet, selv når visningstittelen er det
// norske navnet (verifisert 2026-07-16: "Larus_argentatus" → "Gråmåke",
// "Cancer_pagurus" → "Taskekrabbe", "Vipera_berus" → "Hoggorm").
const WIKIPEDIA_API = 'https://no.wikipedia.org/api/rest_v1/page/summary';

// Noen artikler er reelle stubber der "extract" bare er ett skilletegn
// (bekreftet 2026-07-16: Cancer_pagurus/taskekrabbe ga extract "."). Et for
// kort utdrag er verdiløst som artsomtale — behandles som "ikke funnet".
const MIN_LENGDE = 40;

export async function hentWikipediaSammendrag(latinskNavn) {
  if (!latinskNavn) return null;
  const tittel = latinskNavn.trim().replace(/\s+/g, '_');
  if (!tittel) return null;

  let res;
  try {
    res = await fetch(`${WIKIPEDIA_API}/${encodeURIComponent(tittel)}`, {
      headers: { 'User-Agent': 'BondoyaApp/1.0 (https://bondoya.no)' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const extract = (data.extract || '').trim();
  if (extract.length < MIN_LENGDE) return null;

  return {
    beskrivelse: extract,
    wikipediaUrl: data.content_urls?.desktop?.page || null,
  };
}
