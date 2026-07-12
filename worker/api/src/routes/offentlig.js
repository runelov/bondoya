import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { parseFunnRadOffentlig } from '../lib/funn.js';
import { erFunnSynligForPublic } from '../lib/innstillinger.js';

// Ingen requireSession — dette er det offentlige (uinnloggede) laget, se
// konsept.md "Offentlig lag". Filtreringen på synlig_for_public skjer i
// selve spørringen, ikke i JS etterpå: alt som når parseFunnRadOffentlig
// skal faktisk være trygt å vise uinnlogget. Sjekken på den globale
// admin-bryteren skjer HER (server-side), ikke bare ved at frontend lar
// være å kalle dette endepunktet — noen som analyserer koden og kaller
// /funn/offentlig direkte skal heller ikke få rådata når bryteren er av.
export async function listFunnOffentlig({ env }) {
  const cors = corsHeaders(env);
  if (!(await erFunnSynligForPublic(env))) return json([], 200, cors);

  const { results } = await env.DB.prepare(
    'SELECT * FROM funn WHERE synlig_for_public = 1 ORDER BY tidspunkt DESC'
  ).all();
  return json(results.map(parseFunnRadOffentlig), 200, cors);
}

// Offentlig, minimalt signal (ett boolsk flagg, ingen funn-data) slik at
// frontend kan skjule funnliste-knappen og kartmarkører helt uten først å
// måtte spørre om selve funn-dataene.
export async function hentOffentligInnstillinger({ env }) {
  const cors = corsHeaders(env);
  return json({ funnSynligForPublic: await erFunnSynligForPublic(env) }, 200, cors);
}
