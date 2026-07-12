import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';
import { parseSideRadOffentlig, erSideSynligFor } from '../lib/sider.js';

// Myk sesjonssjekk — i motsetning til requireSession() sine vanlige bruk
// (som avviser med 401 uten gyldig sesjon) skal disse rutene fungere likt
// for uinnlogget og innlogget, bare med ulikt innhold synlig. requireSession()
// returnerer allerede null uten å kaste ved manglende/ugyldig cookie, så det
// er trygt å kalle den uten å håndheve resultatet.
export async function listSider({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);

  const { results } = await env.DB.prepare('SELECT * FROM sider ORDER BY tittel').all();
  const synlige = results.filter((rad) => erSideSynligFor(rad, bruker));
  return json(synlige.map(parseSideRadOffentlig), 200, cors);
}

// 404 (ikke 401) for kladd/ikke-synlig/ikke-eksisterende — konsekvent
// info-hiding, avslører ikke om en pålogget-only side finnes for en
// uinnlogget besøkende.
export async function hentSide({ request, env, params }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);

  const rad = await env.DB.prepare('SELECT * FROM sider WHERE slug = ?').bind(params.slug).first();
  if (!rad || !erSideSynligFor(rad, bruker)) return json({ error: 'Fant ikke siden.' }, 404, cors);

  return json(parseSideRadOffentlig(rad), 200, cors);
}
