// worker/ki-proxy/src/index.js
//
// Minimal Cloudflare Worker som tar imot et feltbilde + en stedsforankret
// artskandidatliste fra Bondøya-appen, kaller KI-motor(er), og returnerer
// strukturerte artsforslag. Eneste jobb: skjule API-nøkler (aldri i
// klientkode) og gi raskt svar (1-3 sek) — se konsept.md for hvorfor dette
// er ett unntak fra "alt er GitHub"-mønsteret.
//
// Kontrakt appen (js/ki-client.js) forventer:
//   POST multipart/form-data: bilde=<fil>, kandidater=<JSON-array>
//   Header: X-App-Secret: <delt hemmelighet, samme idé som GitHub-tokenet>
//   -> 200 { kandidater: [ { norsk, latinsk, artstype, taxonId, konfidens, saertrekk }, ... ] }
// saertrekk: kort tekst om hva i AKKURAT DETTE bildet som peker mot denne
// arten (og ev. skiller den fra de andre kandidatene) — vises i UI-en når KI
// er usikker og gir flere alternativer, se candidateCard i js/app.js.
// taxonId (0.9.45, portert fra søsterproduktet Ramme sin v0.1.3-fiks — se
// losOppManglendeTaxonId() under) løses nå opp server-side for enhver
// kandidat som mangler en, i stedet for å alltid være fraværende slik ren
// Claude-bildegjenkjenning etterlater den. Kan fortsatt være `undefined`
// hvis Artskart-oppslaget ikke gir noe treff — fail-open, se der.
//
// HYBRID (2026-08-27, se "Artsgjenkjenning: veivalg"-notatet for full
// bakgrunn/tall): kaller nå BÅDE Claude vision OG Artsorakel-motoren
// (Artsdatabanken/Naturalis) parallelt for hvert bilde.
//   - Artsorakel svarer kun med {latinsk navn, sannsynlighet} — ingen norsk
//     navn, artstype eller begrunnelse. Løses opp mot Artsdatabankens taxon-
//     søk (samme ARTSKART_API som worker/api/src/routes/arter.js bruker) for
//     å få norsk/artstype, se losArtsorakelTaxon().
//   - Claude leverer fortsatt "saertrekk"-begrunnelsen — Artsorakel gir
//     ingen tekst i det hele tatt. Et Artsorakel-forslag gjenbruker Claudes
//     saertrekk hvis Claude uavhengig kom med samme art, ellers en ærlig,
//     ikke-oppdiktet fallback-tekst (se lagArtsorakelKandidat()).
//   - Fallback til Claudes egen kandidatliste når: (a) toppforslaget fra
//     Artsorakel er et pattedyr/sjøpattedyr — Claude vant klart på nettopp
//     denne kategorien i 81-funns benchmarket (67 % mot Claudes øvrige
//     styrke der), eller (b) Artsorakel er tom/utilgjengelig/feiler. Dette
//     er IKKE en gjetning — det er den eksplisitte konklusjonen fra
//     benchmarket, ikke noe å eksperimentere videre med uten nye tall.
//   - Kostnad/latency-avveining tatt bevisst: Claude kalles alltid (ikke
//     bare ved fallback), fordi vi uansett trenger saertrekk-teksten når
//     Artsorakel vinner. Dobler Anthropic-kallene per registrering — akseptabelt
//     for en app med 10-15 brukere, revurder hvis budsjett blir en sak.
//
// ARTSORAKEL_ENDPOINT / ARTSORAKEL_TOKEN (Worker-hemmeligheter) styrer HVOR
// dette kaller — Artsdatabankens eksplisitte regel (2026-08-27, se
// bondoya-artsdatabanken-outreach.md): all testing/analyse skal gå mot
// ai.test.artsdatabanken.no, KUN selve (produksjons-)appen mot
// ai.artsdatabanken.no. Sett derfor ALDRI produksjonstokenet i
// worker/ki-proxy/.dev.vars — kun i de faktiske deployede Worker-
// hemmelighetene (`wrangler secret put ARTSORAKEL_TOKEN` fra produksjons-
// miljøet). Lokal utvikling/test skal peke mot testendepunktet med
// testtokenet. Begge variablene er valgfrie: uten dem hopper Workeren
// automatisk over Artsorakel-kallet og oppfører seg nøyaktig som før
// hybriden (ren Claude) — trygt å deploye denne endringen før hemmelighetene
// er satt.
//
// Pluggbart: bytt kun denne filen for å bruke en annen/ytterligere KI-motor
// senere uten å røre js/ki-client.js sin kontrakt.
//
// X-App-Secret finnes fordi CORS (Access-Control-Allow-Origin) kun stopper
// NETTLESERE — noen som finner denne Worker-URL-en kan uansett kalle den
// direkte med curl/script og bruke opp Anthropic-/Artsorakel-kredittene
// dine. Sjekken her er ikke vanntett (delt hemmelighet i klientkode), men
// hever terskelen betydelig for en app med 10-15 kjente brukere, konsistent
// med hvordan GitHub-tokenet allerede fungerer som "delt hemmelighet" i
// resten av appen.

const ARTSKART_API = 'https://artskart.artsdatabanken.no/publicapi/api';

// Pattedyr-artstyper Artsorakel taper klart på i benchmarket (seksjon 06b/c
// i "Artsgjenkjenning: veivalg") — eneste "fallback til Claude"-kategori som
// faktisk er datadrevet, ikke en gjetning.
const PATTEDYR_ARTSTYPER = new Set(['pattedyr', 'sjøpattedyr']);

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Kun POST støttes.' }, 405, cors);
    }

    if (!env.APP_SHARED_SECRET) {
      return json({ error: 'Workeren er ikke satt opp riktig: APP_SHARED_SECRET mangler. Sett den med "wrangler secret put APP_SHARED_SECRET".' }, 500, cors);
    }
    if (!timingSafeEqual(request.headers.get('X-App-Secret') || '', env.APP_SHARED_SECRET)) {
      return json({ error: 'Ugyldig eller manglende X-App-Secret.' }, 401, cors);
    }

    // Alt herfra kan i prinsippet kaste en uventet feil (nettverksglipp,
    // uventet KI-respons, stort bilde som treffer Workerens
    // CPU-tidsgrense) — fanges her og gis tilbake som JSON i stedet for
    // Cloudflares uinformative generiske 500-side, slik at appens
    // "KI-gjenkjenning feilet"-konsoll-logg faktisk viser noe nyttig
    // (se js/app.js/ki-client.js).
    try {
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return json({ error: 'Kunne ikke lese multipart/form-data.' }, 400, cors);
      }

      const bildeFil = form.get('bilde');
      if (!bildeFil || typeof bildeFil.arrayBuffer !== 'function') {
        return json({ error: 'Mangler feltet "bilde".' }, 400, cors);
      }
      let kandidater = [];
      try {
        kandidater = JSON.parse(form.get('kandidater') || '[]');
      } catch (e) { /* tom liste er greit */ }

      const buf = await bildeFil.arrayBuffer();
      const mediaType = bildeFil.type && bildeFil.type.startsWith('image/') ? bildeFil.type : 'image/jpeg';

      // Claude og Artsorakel kalles PARALLELT, ikke sekvensielt — Claude sin
      // saertrekk-tekst trengs uansett hvem som "vinner" (se toppkommentar),
      // så det er ingen latency-gevinst i å vente på Artsorakel først.
      const [claudeResultat, artsorakelResultat] = await Promise.all([
        hentClaudeKandidater(buf, mediaType, kandidater, env),
        hentArtsorakelKandidater(buf, mediaType, env),
      ]);

      if (claudeResultat.feil && (!artsorakelResultat || artsorakelResultat.feil)) {
        // Begge motorer feilet — ingenting å falle tilbake på.
        return json({ error: claudeResultat.feil }, 502, cors);
      }

      const sammenslatt = await slaSammenKandidater(claudeResultat, artsorakelResultat);
      const endelig = await losOppManglendeTaxonId(sammenslatt);
      return json({ kandidater: endelig }, 200, cors);
    } catch (e) {
      return json({ error: `Uventet feil i KI-proxyen: ${e.message}` }, 500, cors);
    }
  },
};

// ---------- Claude vision ----------

async function hentClaudeKandidater(buf, mediaType, kandidater, env) {
  const base64 = arrayBufferToBase64(buf);
  const prompt = buildPrompt(kandidater);
  // max_tokens hevet 512 → 1024 (2026-08-21, se benchmark-analysen delt
  // samme dato): et offline-benchmark av denne nøyaktige prompten viste
  // at 512 var for knapt så snart modellen gir 2-3 kandidater med fyldig
  // "saertrekk"-tekst — svaret kappes midt i JSON-en og blir uleselig
  // for parseModelJson(), som i produksjon vises til brukeren som "KI-
  // gjenkjenning feilet" uten noen tydelig årsak.
  const anthropicBody = JSON.stringify({
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  // Anthropic (eller infrastrukturen foran den) svarer av og til med en
  // kort, generisk "error code: 5xx" — et forbigående gateway-hikke, ikke
  // en reell feil med kall/nøkkel/bilde (observert i praksis 2026-07-11).
  // Prøver derfor opptil 2 ganger til på 5xx-feil før vi gir opp.
  let anthropicRes, lastErrText, lastStatus;
  for (let forsok = 1; forsok <= 3; forsok++) {
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: anthropicBody,
      });
    } catch (e) {
      if (forsok === 3) return { feil: `Nettverksfeil mot Anthropic: ${e.message}` };
      continue;
    }
    if (anthropicRes.ok) break;
    lastStatus = anthropicRes.status;
    lastErrText = await anthropicRes.text();
    if (lastStatus < 500 || forsok === 3) {
      return { feil: `KI-kall feilet (${lastStatus}): ${lastErrText}` };
    }
    await new Promise(r => setTimeout(r, forsok * 400));
  }

  let anthropicData;
  try {
    anthropicData = await anthropicRes.json();
  } catch (e) {
    return { feil: `Kunne ikke tolke Anthropic sitt svar som JSON: ${e.message}` };
  }

  const text = (anthropicData.content || []).map(b => b.text || '').join('').trim();
  const parsed = parseModelJson(text);
  if (!parsed) {
    return { feil: 'Kunne ikke tolke KI-svaret som JSON.' };
  }
  return { kandidater: parsed.kandidater || [] };
}

function buildPrompt(kandidater) {
  const kandidatTekst = kandidater.length
    ? kandidater.slice(0, 20).map(k =>
        `- ${k.norsk} (${k.latinsk}), artstype: ${k.artstype}, ${
          k.plausibilitet > 0 ? `observert ${k.plausibilitet} ganger tidligere nær dette stedet` : 'ikke tidligere observert nær dette stedet, men økologisk mulig'
        }`
      ).join('\n')
    : '(ingen stedsspesifikk kandidatliste tilgjengelig)';

  return `Du identifiserer arter (fugl, planter, alger, sopp, sjøpattedyr, fisk, bløtdyr, krepsdyr, \
insekt, edderkoppdyr, krypdyr, amfibium, nesledyr, pigghud, leddorm) fra feltbilder tatt på \
Bondøya, en liten værhard kystøy i Ytre Vikna, Trøndelag, Norge. Dette er en homogen \
kystlokalitet — innlandsarter og fjellarter er svært usannsynlige her.

Lokalt kjente/plausible arter (prioriter disse, men si tydelig fra hvis bildet \
åpenbart viser noe annet):
${kandidatTekst}

Se på bildet og gi 1-3 kandidater, sortert med mest sannsynlige først. Vær ærlig \
om usikkerhet — ikke tving frem en lokal art hvis bildet klart viser noe annet.

For HVER kandidat: skriv ett kort setning (maks ca. 20 ord, på norsk) i "saertrekk" \
om hva du konkret ser i DETTE bildet som peker mot akkurat denne arten — og som \
skiller den fra de andre kandidatene du foreslår (f.eks. nebbform, fargetegning, \
vokseform, størrelsesforhold). Dette vises direkte til brukeren for å hjelpe dem \
velge riktig når du er usikker, så vær konkret og bildespesifikk, ikke en generisk \
artsbeskrivelse.

Svar KUN med gyldig JSON i nøyaktig dette formatet, ingen annen tekst, ingen \
markdown-kodeblokk:
{"kandidater":[{"norsk":"...","latinsk":"...","artstype":"fugl|pattedyr|sjøpattedyr|plante|alge|sopp|fisk|bløtdyr|krepsdyr|insekt|edderkoppdyr|krypdyr|amfibium|nesledyr|pigghud|leddorm|annet","konfidens":0.0,"saertrekk":"..."}]}`;
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { return null; }
    }
    return null;
  }
}

// ---------- Artsorakel (Artsdatabanken/Naturalis) ----------

// Uten disse to hemmelighetene hopper vi rett over Artsorakel-kallet og
// oppfører oss nøyaktig som ren-Claude-versjonen — se toppkommentaren for
// hvorfor det er bevisst trygt å deploye denne filen før hemmelighetene er
// satt.
async function hentArtsorakelKandidater(buf, mediaType, env) {
  if (!env.ARTSORAKEL_ENDPOINT || !env.ARTSORAKEL_TOKEN) return null;

  const form = new FormData();
  form.append('application', 'Bondøya');
  form.append('image', new Blob([buf], { type: mediaType }), 'bilde.jpg');

  // Kort timeout (4s) — Artsorakel er et supplement, ikke kritisk sti. En
  // treg/hengende Artsorakel skal aldri forsinke Claude-svaret appen uansett
  // venter på (Promise.all venter på begge, men vi vil ikke la ett tregt
  // kall gjøre HELE registreringen treg utover det Claude allerede tar).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(env.ARTSORAKEL_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ARTSORAKEL_TOKEN}` },
      body: form,
      signal: controller.signal,
    });
    const tekst = await res.text();
    if (!res.ok) return { feil: `Artsorakel svarte ${res.status}: ${tekst.slice(0, 200)}` };
    let data;
    try { data = JSON.parse(tekst); } catch { return { feil: 'Artsorakel svarte med ugyldig JSON.' }; }
    const items = data?.predictions?.[0]?.taxa?.items || [];
    return { kandidater: items.map(i => ({ latinsk: i.scientific_name, sannsynlighet: i.probability || 0 })) };
  } catch (e) {
    return { feil: `Nettverksfeil/timeout mot Artsorakel: ${e.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// Slår opp et vitenskapelig navn mot Artsdatabankens taxon-søk for å finne
// norsk navn/artstype/taxonId — Artsorakel oppgir kun det latinske navnet.
// Samme endepunkt og samme filter (artsnivå + har norsk navn) som
// worker/api/src/routes/arter.js sin sokArter() bruker, verifisert live
// 2026-08-27 (f.eks. "Alces alces" gir to treff — en underart uten norsk
// navn og selve arten "elg" med norsk navn — filteret plukker riktig ett).
// Bevisst en liten, selvstendig kopi av taxonomi.js sin utledArtstype() i
// stedet for en delt import: worker/ki-proxy og worker/api er to uavhengig
// deployede Workere uten delt kodebase (samme begrunnelse som ARTSTYPER-
// arrayet i js/app.js holdes i synk for hånd, se CLAUDE.md).
async function losArtsorakelTaxon(latinskNavn) {
  try {
    const res = await fetch(`${ARTSKART_API}/taxon?term=${encodeURIComponent(latinskNavn)}&take=10`);
    if (!res.ok) return null;
    const raa = await res.json();
    const treff = (Array.isArray(raa) ? raa : []).filter(t => t.SubSpecies == null && t.PrefferedPopularname);
    if (treff.length === 0) return null;
    const eksakt = treff.find(t => normNavn(t.ValidScientificName) === normNavn(latinskNavn));
    const t = eksakt || treff[0];
    return { norsk: t.PrefferedPopularname, latinsk: t.ValidScientificName, taxonId: t.TaxonId, artstype: utledArtstypeForTaxon(t) };
  } catch {
    return null;
  }
}

// Trimmet subsett av worker/api/src/lib/taxonomi.js sin utledArtstype() —
// dekker kategoriene som faktisk er relevante for KI-forslag (ingen
// rødliste-/subsp.-håndtering nødvendig her). Se den filen for full
// begrunnelse per kategorigrense.
function utledArtstypeForTaxon(t) {
  if (t.TaxonGroup === 'Fugler') return 'fugl';
  if (t.TaxonGroup === 'Alger') return 'alge';
  if (t.Kingdom === 'Plantae') return 'plante';
  if (t.Kingdom === 'Fungi') return 'sopp';
  if (t.TaxonGroup === 'Fisker') return 'fisk';
  if (t.TaxonGroup === 'Bløtdyr') return 'bløtdyr';
  if (t.TaxonGroup === 'Krepsdyr') return 'krepsdyr';
  if (t.Class === 'Mammalia') {
    const SJOPATTEDYR_FAMILIER = new Set(['Phocidae', 'Otariidae', 'Odobenidae', 'Balaenopteridae', 'Delphinidae', 'Monodontidae', 'Physeteridae', 'Ziphiidae']);
    return SJOPATTEDYR_FAMILIER.has(t.Family) ? 'sjøpattedyr' : 'pattedyr';
  }
  if (t.Class === 'Insecta') return 'insekt';
  if (t.Class === 'Arachnida') return 'edderkoppdyr';
  if (t.Class === 'Reptilia') return 'krypdyr';
  if (t.Class === 'Amphibia') return 'amfibium';
  if (t.TaxonGroup === 'svamper, nesledyr, kammaneter') return 'nesledyr';
  if (t.TaxonGroup === 'Armfotinger, pigghuder, kappedyr') return 'pigghud';
  if (t.TaxonGroup === 'Leddormer') return 'leddorm';
  return 'annet';
}

function normNavn(s) {
  return (s || '').toLowerCase().replace(/\s+subsp\.?\s+\S+$/, '').replace(/\s+var\.?\s+\S+$/, '').trim();
}

// ---------- Sammenslåing ----------

// Beslutningen her er datadrevet, ikke en gjetning — se toppkommentaren og
// "Artsgjenkjenning: veivalg" seksjon 06b/06c: Artsorakel slår Claude klart
// (79 % mot 53 % topp-1, N=81) unntatt på pattedyr/sjøpattedyr, der Claude
// vinner. Faller også tilbake til Claude hvis Artsorakel er tom/feilet.
async function slaSammenKandidater(claudeResultat, artsorakelResultat) {
  const claudeKandidater = claudeResultat.feil ? [] : (claudeResultat.kandidater || []);

  if (!artsorakelResultat || artsorakelResultat.feil || !artsorakelResultat.kandidater?.length) {
    return claudeKandidater;
  }

  // Løs opp topp 3 Artsorakel-kandidater parallelt (avgrenset for latency).
  const topp3 = artsorakelResultat.kandidater.slice(0, 3);
  const taxa = await Promise.all(topp3.map(k => losArtsorakelTaxon(k.latinsk)));

  const forsteTaxon = taxa[0];
  const usikkerEllerTom = !forsteTaxon;
  const erPattedyr = forsteTaxon && PATTEDYR_ARTSTYPER.has(forsteTaxon.artstype);
  if (usikkerEllerTom || erPattedyr) {
    return claudeKandidater;
  }

  return topp3
    .map((k, i) => {
      const t = taxa[i];
      if (!t) return null; // enkeltkandidat vi ikke klarte å slå opp — dropp den, ikke gjett
      return lagArtsorakelKandidat(t, k.sannsynlighet, claudeKandidater);
    })
    .filter(Boolean);
}

function lagArtsorakelKandidat(taxon, sannsynlighet, claudeKandidater) {
  const treff = claudeKandidater.find(c => normNavn(c.latinsk) === normNavn(taxon.latinsk));
  return {
    norsk: taxon.norsk,
    latinsk: taxon.latinsk,
    artstype: taxon.artstype,
    taxonId: taxon.taxonId, // MANGLET her tidligere (til 0.9.45) — se losOppManglendeTaxonId()
    konfidens: sannsynlighet,
    // Ærlig fallback fremfor å dikte opp en bildespesifikk begrunnelse
    // Artsorakel ikke har gitt oss noe grunnlag for — se toppkommentaren.
    saertrekk: treff ? treff.saertrekk : 'Foreslått av Artsorakel — ingen bildespesifikk begrunnelse tilgjengelig.',
  };
}

// Portert fra søsterproduktet Ramme (v0.1.3, samme kodebase-opphav — se
// CLAUDE.md sin "Shared architecture"-seksjon). Reell konsekvens oppdaget
// der ved faktisk bruk, og som gjelder identisk her: Claude vision gjør ren
// bildegjenkjenning og oppgir ALDRI en taxonId (se hentClaudeKandidater()),
// og lagArtsorakelKandidat() over mistet den til en egen, ubeslektet glipp
// fram til 0.9.45. Uten taxonId kan verken "Oppdageren" eller "Rødlistejeger"
// (se worker/api/src/lib/fremdrift.js) noensinne utløses for et funn
// brukeren bare aksepterte KI-forslaget for, uten å bekrefte via artssøket
// separat — badges er en bonusfunksjon her (ikke selve hovedpoenget, som i
// Ramme), men svekkes på samme måte for enhver bruker som stoler direkte på
// et KI-forslag. Løser opp taxonId server-side for ENHVER kandidat som
// mangler en, via samme Artskart-taxon-oppslag Artsorakel-stien allerede
// bruker. Fail-open ved oppslagsfeil/ikke-treff: kandidaten beholdes UTEN
// taxonId fremfor å forsvinne.
async function losOppManglendeTaxonId(kandidater) {
  return Promise.all(
    kandidater.map(async (k) => {
      if (k.taxonId) return k;
      const t = await losArtsorakelTaxon(k.latinsk).catch(() => null);
      if (!t) return k;
      // Overstyr Claude sin gjettede artstype med den autoritative
      // taxonomi-utledningen når vi uansett har taxonId nå — samme prinsipp
      // som worker/api/src/lib/taxonomi.js sin server-side-autoritative
      // artstype-utledning fra taxonId ved lagring.
      return { ...k, taxonId: t.taxonId, artstype: t.artstype };
    })
  );
}

// ---------- Delt ----------

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Konstant-tid strengsammenligning — unngår at responstiden lekker info om
// hvor mange tegn av hemmeligheten som stemte (mindre relevant på denne
// skalaen, men billig å gjøre riktig).
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}
