import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';
import { sjekkOgTellIp } from '../lib/ratelimit.js';
import { utledArtstype, ARTSKART_API } from '../lib/taxonomi.js';
import { hentWikipediaSammendrag } from '../lib/wikipedia.js';

// Live søkeproxy mot Artsdatabankens offentlige taxon-API — samme vert
// fetch_artskart.py (bondoya-db) allerede bruker for taxon-ID-oppslag.
// Bevisst IKKE en egen ETL-jobb/D1-tabell (se plan/konsept.md "Ordentlig
// artssøk"): et direkte oppslag er enklere, alltid ferskt, og krever ingen
// ny privat-repo-pipeline. Delstrengsøk på norsk populærnavn verifisert
// 2026-07-12 (term=ørn ga treff).
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

// Cache-aside artsomtale: admin-skrevet tekst i arter_metadata (migrations/
// 0015) vinner alltid; uten en slik rad prøver vi Wikipedia én gang og
// lagrer treffet for neste oppslag av samme art (delt på tvers av alle funn
// av arten, ikke duplisert per funn — se migrasjonens kommentar for hvorfor).
// ?latinsk sendes av klienten (allerede kjent fra funnet/søketreffet) for å
// unngå et ekstra Artsdatabanken-oppslag her bare for å finne navnet.
export async function hentArtsbeskrivelse({ request, env, params }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  const taxonId = parseInt(params.taxonId, 10);
  if (!Number.isFinite(taxonId) || taxonId <= 0) return json({ error: 'Ugyldig taxonId.' }, 400, cors);

  const eksisterende = await env.DB.prepare(
    'SELECT beskrivelse, kilde, wikipedia_url FROM arter_metadata WHERE taxon_id = ?'
  ).bind(taxonId).first();
  if (eksisterende) {
    return json(
      { beskrivelse: eksisterende.beskrivelse, kilde: eksisterende.kilde, wikipediaUrl: eksisterende.wikipedia_url },
      200,
      cors
    );
  }

  const latinskNavn = (new URL(request.url).searchParams.get('latinsk') || '').trim();
  const wiki = await hentWikipediaSammendrag(latinskNavn);
  if (!wiki) return json({ beskrivelse: null, kilde: null, wikipediaUrl: null }, 200, cors);

  // INSERT OR IGNORE-mønster (ON CONFLICT DO NOTHING): et samtidig kall for
  // samme taxonId kan ha rukket å skrive først — admin-tekst skal aldri
  // overskrives av dette, og to identiske Wikipedia-skriv er uskadelig å
  // bare hoppe over.
  await env.DB.prepare(
    `INSERT INTO arter_metadata (taxon_id, beskrivelse, kilde, wikipedia_url)
     VALUES (?, ?, 'wikipedia', ?)
     ON CONFLICT(taxon_id) DO NOTHING`
  ).bind(taxonId, wiki.beskrivelse, wiki.wikipediaUrl).run();

  return json({ beskrivelse: wiki.beskrivelse, kilde: 'wikipedia', wikipediaUrl: wiki.wikipediaUrl }, 200, cors);
}
