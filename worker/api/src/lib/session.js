import { randomToken, sha256Hex } from './crypto.js';

const COOKIE_NAVN = 'bondoya_sesjon';
const LEVETID_MS = 30 * 24 * 60 * 60 * 1000; // 30 dager

export async function opprettSesjon(brukerId, env) {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const utloper = Date.now() + LEVETID_MS;
  await env.DB.prepare('INSERT INTO sesjoner (hash, bruker_id, utloper) VALUES (?, ?, ?)')
    .bind(hash, brukerId, utloper)
    .run();
  return token;
}

// Ingen Domain-attributt (host-only på api.bondoya.no) — SameSite stopper
// kun cross-*site*, ikke cross-*origin*-innenfor-samme-site, så cookien
// sendes fint fra bondoya.no sine fetch()-kall uten å måtte deles unødig
// bredt med f.eks. GitHub Pages-siden. Se konsept.md "Eget domene".
export function sesjonCookieHeader(token) {
  return `${COOKIE_NAVN}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${LEVETID_MS / 1000}`;
}

export function slettSesjonCookieHeader() {
  return `${COOKIE_NAVN}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Den delte autorisasjonsfunksjonen konsept.md krever — alle beskyttede
// ruter kaller DENNE, aldri en egen kopiert sjekk. Umiddelbar
// tilbaketrekking ved deaktivering: status sjekkes på hver forespørsel,
// ikke bare ved innlogging (derfor sesjonsbasert i D1, ikke JWT).
export async function requireSession(request, env) {
  const token = parseCookie(request.headers.get('Cookie') || '', COOKIE_NAVN);
  if (!token) return null;

  const hash = await sha256Hex(token);
  const rad = await env.DB.prepare(
    `SELECT brukere.id, brukere.epost, brukere.kortnavn, brukere.rolle, brukere.status
     FROM sesjoner
     JOIN brukere ON brukere.id = sesjoner.bruker_id
     WHERE sesjoner.hash = ?1 AND sesjoner.utloper > ?2`
  )
    .bind(hash, Date.now())
    .first();

  if (!rad || rad.status !== 'aktiv') return null;
  return rad;
}

export async function slettSesjon(request, env) {
  const token = parseCookie(request.headers.get('Cookie') || '', COOKIE_NAVN);
  if (!token) return;
  const hash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sesjoner WHERE hash = ?').bind(hash).run();
}

function parseCookie(header, navn) {
  for (const del of header.split(';')) {
    const i = del.indexOf('=');
    if (i === -1) continue;
    if (del.slice(0, i).trim() === navn) return decodeURIComponent(del.slice(i + 1).trim());
  }
  return null;
}
