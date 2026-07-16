import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';

// Svarer alltid 200 — dette er en statussjekk, ikke en beskyttet ressurs.
// "Ikke innlogget" er et normalt, forventet svar (appstart, enhver
// offentlig besøkende), ikke en feilsituasjon som fortjener 401. Med 401
// her logget nettleserens DevTools en rød konsollfeil for HVER offentlig
// besøkende, uavhengig av at klienten selv håndterte det helt fint — se
// js/api-client.js sin meg().
export async function meg({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ loggedIn: false }, 200, cors);
  return json({ loggedIn: true, epost: bruker.epost, kortnavn: bruker.kortnavn, rolle: bruker.rolle }, 200, cors);
}
