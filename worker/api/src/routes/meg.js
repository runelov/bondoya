import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';

export async function meg({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);
  return json({ epost: bruker.epost, kortnavn: bruker.kortnavn, rolle: bruker.rolle }, 200, cors);
}
