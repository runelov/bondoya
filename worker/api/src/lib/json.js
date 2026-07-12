// Portert fra worker/ki-proxy/src/index.js sitt json()-mønster.
export function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
