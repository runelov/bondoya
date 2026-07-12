// Speiler worker/ki-proxy sitt CORS-mønster, men bredere: flere HTTP-metoder
// (denne workeren har faktiske ruter, ikke bare ett endepunkt), og
// Allow-Credentials siden auth bruker en cookie (fetch() med
// credentials:'include' fra frontend) — en wildcard-origin er ikke lov
// sammen med credentials, så ALLOWED_ORIGIN må alltid være ett eksakt opphav.
export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
