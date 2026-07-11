// worker/ki-proxy/src/index.js
//
// Minimal Cloudflare Worker som tar imot et feltbilde + en stedsforankret
// artskandidatliste fra Bondøya-appen, kaller Claude vision, og
// returnerer strukturerte artsforslag. Eneste jobb: skjule ANTHROPIC_API_KEY
// (aldri i klientkode) og gi raskt svar (1-3 sek) — se konsept.md for hvorfor
// dette er ett unntak fra "alt er GitHub"-mønsteret.
//
// Kontrakt appen (js/ki-client.js) forventer:
//   POST multipart/form-data: bilde=<fil>, kandidater=<JSON-array>
//   Header: X-App-Secret: <delt hemmelighet, samme idé som GitHub-tokenet>
//   -> 200 { kandidater: [ { norsk, latinsk, artstype, konfidens }, ... ] }
// Pluggbart: bytt kun denne filen for å bruke en annen KI-motor (f.eks.
// iNaturalist CV) senere uten å røre js/ki-client.js sin kontrakt.
//
// X-App-Secret finnes fordi CORS (Access-Control-Allow-Origin) kun stopper
// NETTLESERE — noen som finner denne Worker-URL-en kan uansett kalle den
// direkte med curl/script og bruke opp Anthropic-kredittene dine. Sjekken her
// er ikke vanntett (delt hemmelighet i klientkode), men hever terskelen
// betydelig for en app med 10-15 kjente brukere, konsistent med hvordan
// GitHub-tokenet allerede fungerer som "delt hemmelighet" i resten av appen.

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
    // uventet Anthropic-respons, stort bilde som treffer Workerens
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
      const base64 = arrayBufferToBase64(buf);
      const mediaType = bildeFil.type && bildeFil.type.startsWith('image/') ? bildeFil.type : 'image/jpeg';

      const prompt = buildPrompt(kandidater);
      const anthropicBody = JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 512,
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
          if (forsok === 3) return json({ error: `Nettverksfeil mot Anthropic: ${e.message}` }, 502, cors);
          continue;
        }
        if (anthropicRes.ok) break;
        lastStatus = anthropicRes.status;
        lastErrText = await anthropicRes.text();
        if (lastStatus < 500 || forsok === 3) {
          return json({ error: `KI-kall feilet (${lastStatus}): ${lastErrText}` }, 502, cors);
        }
        await new Promise(r => setTimeout(r, forsok * 400));
      }

      let anthropicData;
      try {
        anthropicData = await anthropicRes.json();
      } catch (e) {
        return json({ error: `Kunne ikke tolke Anthropic sitt svar som JSON: ${e.message}` }, 502, cors);
      }

      const text = (anthropicData.content || []).map(b => b.text || '').join('').trim();
      const parsed = parseModelJson(text);
      if (!parsed) {
        return json({ error: 'Kunne ikke tolke KI-svaret som JSON.', raw: text }, 502, cors);
      }

      return json({ kandidater: parsed.kandidater || [] }, 200, cors);
    } catch (e) {
      return json({ error: `Uventet feil i KI-proxyen: ${e.message}` }, 500, cors);
    }
  },
};

function buildPrompt(kandidater) {
  const kandidatTekst = kandidater.length
    ? kandidater.slice(0, 20).map(k =>
        `- ${k.norsk} (${k.latinsk}), artstype: ${k.artstype}, ${
          k.plausibilitet > 0 ? `observert ${k.plausibilitet} ganger tidligere nær dette stedet` : 'ikke tidligere observert nær dette stedet, men økologisk mulig'
        }`
      ).join('\n')
    : '(ingen stedsspesifikk kandidatliste tilgjengelig)';

  return `Du identifiserer arter (fugl, planter, alger, sjøpattedyr) fra feltbilder tatt på \
Bondøya, en liten værhard kystøy i Ytre Vikna, Trøndelag, Norge. Dette er en homogen \
kystlokalitet — innlandsarter og fjellarter er svært usannsynlige her.

Lokalt kjente/plausible arter (prioriter disse, men si tydelig fra hvis bildet \
åpenbart viser noe annet):
${kandidatTekst}

Se på bildet og gi 1-3 kandidater, sortert med mest sannsynlige først. Vær ærlig \
om usikkerhet — ikke tving frem en lokal art hvis bildet klart viser noe annet.

Svar KUN med gyldig JSON i nøyaktig dette formatet, ingen annen tekst, ingen \
markdown-kodeblokk:
{"kandidater":[{"norsk":"...","latinsk":"...","artstype":"fugl|pattedyr|sjøpattedyr|plante|alge|annet","konfidens":0.0}]}`;
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
