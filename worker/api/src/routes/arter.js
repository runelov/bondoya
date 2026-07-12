import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';
import { sjekkOgTellIp } from '../lib/ratelimit.js';

// Live søkeproxy mot Artsdatabankens offentlige taxon-API — samme vert
// fetch_artskart.py (bondoya-db) allerede bruker for taxon-ID-oppslag.
// Bevisst IKKE en egen ETL-jobb/D1-tabell (se plan/konsept.md "Ordentlig
// artssøk"): et direkte oppslag er enklere, alltid ferskt, og krever ingen
// ny privat-repo-pipeline. Delstrengsøk på norsk populærnavn verifisert
// 2026-07-12 (term=ørn ga treff).
const ARTSKART_API = 'https://artskart.artsdatabanken.no/publicapi/api';
const MAKS_SOK_PER_IP_TIME = 60;
const MAKS_TREFF = 15;
// Udokumentert, men verifisert empirisk 2026-07-12: endepunktet returnerer
// kun 15 treff uten "take"-parameteret, uavhengig av faktisk treffantall —
// for korte/vanlige søk (f.eks. "rødstrupe", som er prefiks for et dusin
// tropiske arter) kan dette kutte vekk selve basisarten. `take=40` løfter
// det reelle taket høyt nok til at basisarten nesten alltid er med, og vi
// sorterer selv på relevans (se sorterEtterRelevans) før vi kutter til
// MAKS_TREFF.
const HENT_TAKE = 40;

// Artsdatabankens TaxonGroup/Kingdom/Class/Family dekker ikke appens
// artstype-skjema 1:1 (spesielt sjøpattedyr vs. pattedyr — Artsdatabanken
// har ingen egen "Sjøpattedyr"-gruppe, steinkobbe havner under samme
// TaxonGroup "Pattedyr" som f.eks. elg). Verifisert live 2026-07-12 mot
// faktiske treff (steinkobbe → TaxonGroup "Pattedyr", Family "Phocidae";
// sukkertare → TaxonGroup "Alger"). Liten hardkodet familie-allowliste for
// de sjøpattedyrfamiliene som realistisk kan dukke opp ved Bondøya.
const SJOPATTEDYR_FAMILIER = new Set([
  'Phocidae', 'Otariidae', 'Odobenidae',
  'Balaenopteridae', 'Delphinidae', 'Monodontidae', 'Physeteridae', 'Ziphiidae',
]);

// Eksakt treff først, deretter navn som starter med søketermen (korteste —
// mest sannsynlig basisarten — foran lengre sammensetninger), resten sist.
function sorterEtterRelevans(treff, term) {
  const t = term.toLowerCase();
  const rangering = (navn) => {
    const n = navn.toLowerCase();
    if (n === t) return 0;
    if (n.startsWith(t)) return 1;
    return 2;
  };
  return treff.slice().sort((a, b) => {
    const ra = rangering(a.norsk);
    const rb = rangering(b.norsk);
    if (ra !== rb) return ra - rb;
    return a.norsk.length - b.norsk.length;
  });
}

function utledArtstype(taxon) {
  if (taxon.TaxonGroup === 'Fugler') return 'fugl';
  if (taxon.TaxonGroup === 'Alger') return 'alge';
  if (taxon.Kingdom === 'Plantae') return 'plante';
  if (taxon.Class === 'Mammalia') {
    return SJOPATTEDYR_FAMILIER.has(taxon.Family) ? 'sjøpattedyr' : 'pattedyr';
  }
  return 'annet';
}

export async function sokArter({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  const term = (new URL(request.url).searchParams.get('q') || '').trim();
  if (term.length < 2) return json([], 200, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'ukjent';
  const ipOk = await sjekkOgTellIp(ip, 'arter-sok', MAKS_SOK_PER_IP_TIME, env);
  if (!ipOk) return json({ error: 'For mange forespørsler. Prøv igjen senere.' }, 429, cors);

  let raa;
  try {
    const res = await fetch(`${ARTSKART_API}/taxon?term=${encodeURIComponent(term)}&take=${HENT_TAKE}`);
    if (!res.ok) return json({ error: 'Artsdatabanken svarte ikke.' }, 502, cors);
    raa = await res.json();
  } catch (e) {
    console.error(e);
    return json({ error: 'Kunne ikke nå Artsdatabanken.' }, 502, cors);
  }

  const treff = (Array.isArray(raa) ? raa : [])
    // Kun artsnivå (samme konvensjon som fetch_artskart.py) og kun taxa med
    // et faktisk norsk navn — appen viser alltid norsk navn i UI-en.
    .filter((t) => t.SubSpecies == null && t.PrefferedPopularname)
    .map((t) => ({
      norsk: t.PrefferedPopularname,
      latinsk: t.ValidScientificName || '',
      taxonId: t.TaxonId,
      artstype: utledArtstype(t),
    }));

  return json(sorterEtterRelevans(treff, term).slice(0, MAKS_TREFF), 200, cors);
}
