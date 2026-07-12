import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { parseFunnRadOffentlig } from '../lib/funn.js';

// Ingen requireSession — dette er det offentlige (uinnloggede) laget, se
// konsept.md "Offentlig lag". Filtreringen på synlig_for_public skjer i
// selve spørringen, ikke i JS etterpå: alt som når parseFunnRadOffentlig
// skal faktisk være trygt å vise uinnlogget.
export async function listFunnOffentlig({ env }) {
  const cors = corsHeaders(env);
  const { results } = await env.DB.prepare(
    'SELECT * FROM funn WHERE synlig_for_public = 1 ORDER BY tidspunkt DESC'
  ).all();
  return json(results.map(parseFunnRadOffentlig), 200, cors);
}
