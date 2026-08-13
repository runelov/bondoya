// worker/api/src/routes/artskart.js
// Erstatter den tidligere klient-side GhStore-tilkoblingen (⚙️-panelet, fjernet
// i denne endringen — se konsept.md "Avvikling av ⚙️-innstillingspanelet"):
// i stedet for at en admin limer inn sin egen GitHub PAT i nettleseren for å
// lese bondoya-db sin artskart-cache direkte, PUSHER bondoya-db sin ukentlige
// fetch_artskart.py-jobb nå resultatet hit, og alle innloggede brukere leser
// det derfra — ingen GitHub-tilgang fra denne workeren i det hele tatt,
// ingen personlig token å konfigurere per enhet.
//
// To ruter:
// - POST /intern/artskart-oppdatering: kalles kun av GitHub Actions-jobben i
//   bondoya-db, autentisert med en delt hemmelighet (X-App-Secret, samme
//   mønster som worker/ki-proxy sin APP_SHARED_SECRET) — IKKE sesjonsbasert,
//   dette er et maskin-til-maskin-kall, ingen bruker er innlogget når det skjer.
// - GET /arter/lokale-observasjoner: sesjonsbeskyttet (en hvilken som helst
//   innlogget bruker, ikke admin-only — i motsetning til det gamle ⚙️-panelet,
//   som utilsiktet kun ga artskart-berikelse på den ene enheten en admin
//   hadde limt inn tokenet sitt på, får nå ALLE innloggede samme data).

import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';
import { timingSafeEqual } from '../lib/crypto.js';

const KV_NOKKEL = 'lokale-observasjoner';

export async function oppdaterLokaleObservasjoner({ request, env }) {
  const cors = corsHeaders(env);

  if (!env.ARTSKART_PUSH_SECRET) {
    return json({ error: 'Workeren er ikke satt opp riktig: ARTSKART_PUSH_SECRET mangler. Sett den med "wrangler secret put ARTSKART_PUSH_SECRET".' }, 500, cors);
  }
  if (!timingSafeEqual(request.headers.get('X-App-Secret') || '', env.ARTSKART_PUSH_SECRET)) {
    return json({ error: 'Ugyldig eller manglende X-App-Secret.' }, 401, cors);
  }

  let observasjoner;
  try {
    observasjoner = await request.json();
  } catch {
    return json({ error: 'Ugyldig JSON.' }, 400, cors);
  }
  if (!Array.isArray(observasjoner)) {
    return json({ error: 'Forventet en JSON-liste av observasjoner.' }, 400, cors);
  }

  const oppdatert = new Date().toISOString();
  await env.REFERANSEDATA.put(KV_NOKKEL, JSON.stringify({ oppdatert, observasjoner }));

  return json({ ok: true, antall: observasjoner.length, oppdatert }, 200, cors);
}

export async function hentLokaleObservasjoner({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  const lagret = await env.REFERANSEDATA.get(KV_NOKKEL);
  if (!lagret) return json({ oppdatert: null, observasjoner: [] }, 200, cors);

  try {
    return json(JSON.parse(lagret), 200, cors);
  } catch {
    // Skal aldri skje (vi skriver alltid gyldig JSON selv), men fail-closed
    // med tom liste er tryggere enn å kaste 500 og knekke artsforslag-UX-en.
    return json({ oppdatert: null, observasjoner: [] }, 200, cors);
  }
}
