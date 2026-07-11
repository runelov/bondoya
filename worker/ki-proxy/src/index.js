// worker/ki-proxy/src/index.js
//
// Minimal Cloudflare Worker som tar imot et feltbilde + en stedsforankret
// artskandidatliste fra Mitt Bondøya-appen, kaller Claude vision, og
// returnerer strukturerte artsforslag. Eneste jobb: skjule ANTHROPIC_API_KEY
// (aldri i klientkode) og gi raskt svar (1-3 sek) — se konsept.md for hvorfor
// dette er ett unntak fra "alt er GitHub"-mønsteret.
//
// Kontrakt appen (js/ki-client.js) forventer:
//   POST multipart/form-data: bilde=<fil>, kandidater=<JSON-array>
//   -> 200 { kandidater: [ { norsk, latinsk, artstype, konfidens }, ... ] }
// Pluggbart: bytt kun denne filen for å bruke en annen KI-motor (f.eks.
// iNaturalist CV) senere uten å røre js/ki-client.js sin kontrakt.

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Kun POST støttes.' }, 405, cors);
    }

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

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return json({ error: `KI-kall feilet (${anthropicRes.status}): ${errText}` }, 502, cors);
    }

    const anthropicData = await anthropicRes.json();
    const text = (anthropicData.content || []).map(b => b.text || '').join('').trim();
    const parsed = parseModelJson(text);
    if (!parsed) {
      return json({ error: 'Kunne ikke tolke KI-svaret som JSON.', raw: text }, 502, cors);
    }

    return json({ kandidater: parsed.kandidater || [] }, 200, cors);
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
{"kandidater":[{"norsk":"...","latinsk":"...","artstype":"fugl|sjøpattedyr|alge|blomst|annet","konfidens":0.0}]}`;
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
