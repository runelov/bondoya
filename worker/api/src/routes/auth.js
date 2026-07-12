import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { sjekkOgTellEpost, sjekkOgTellIp } from '../lib/ratelimit.js';
import { sendInnloggingsLenke } from '../lib/epost.js';
import { opprettSesjon, sesjonCookieHeader, slettSesjonCookieHeader, slettSesjon } from '../lib/session.js';

const TOKEN_LEVETID_MS = 15 * 60 * 1000; // 15 minutter
const MAALTID_MS = 700; // se tidsnormaliser()

export async function beOmLenke({ request, env, url }) {
  const start = Date.now();
  const cors = corsHeaders(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  const epost = (body.epost || '').trim().toLowerCase();
  if (!epost) return json({ error: 'E-post mangler.' }, 400, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'ukjent';

  // Rekkefølge er bevisst: Turnstile → rate-limit → eksistenssjekk. En 429
  // her lekker ikke om e-posten finnes, bare at avsenderen har sendt mange
  // forespørsler — trygt å skille ut som egen respons.
  const turnstileOk = await verifyTurnstile(body.turnstileToken, ip, env);
  if (!turnstileOk) {
    return json({ error: 'Kunne ikke bekrefte at forespørselen er ekte.' }, 400, cors);
  }

  const ipOk = await sjekkOgTellIp(ip, 'be-om-lenke', 8, env);
  const epostOk = ipOk ? await sjekkOgTellEpost(epost, env) : false;
  if (!ipOk || !epostOk) {
    return json({ error: 'For mange forsøk. Prøv igjen senere.' }, 429, cors);
  }

  // Fra her: IDENTISK generisk respons uansett treff/ikke-treff, med
  // tidsnormalisert ferdigstillelse — se konsept.md "Sikring av
  // innloggingssiden". Ikke legg til noen gren under som kan returnere
  // tidligere eller med annen tekst enn suksess-responsen nederst.
  const bruker = await env.DB.prepare('SELECT id FROM brukere WHERE epost = ?1 AND status = ?2')
    .bind(epost, 'aktiv')
    .first();

  if (bruker) {
    const rawToken = randomToken();
    const hash = await sha256Hex(rawToken);
    const utloper = Date.now() + TOKEN_LEVETID_MS;
    await env.DB.prepare('INSERT INTO innloggingstokens (hash, bruker_id, utloper) VALUES (?, ?, ?)')
      .bind(hash, bruker.id, utloper)
      .run();

    const lenkeUrl = `${url.origin}/auth/verifiser?token=${rawToken}`;
    try {
      await sendInnloggingsLenke(epost, lenkeUrl, env);
    } catch (e) {
      // Svelges bevisst — responsen skal fortsatt se generisk/vellykket ut.
      console.error('Sending av innloggingslenke feilet:', e.message);
    }
  }

  await tidsnormaliser(start);
  return json(
    { melding: 'Hvis denne e-posten er registrert, har du fått en innloggingslenke.' },
    200,
    cors
  );
}

export async function verifiser({ request, env, url }) {
  const cors = corsHeaders(env);
  const ip = request.headers.get('CF-Connecting-IP') || 'ukjent';

  const ipOk = await sjekkOgTellIp(ip, 'verifiser', 20, env);
  if (!ipOk) return json({ error: 'For mange forsøk. Prøv igjen senere.' }, 429, cors);

  const rawToken = url.searchParams.get('token');
  if (!rawToken) return json({ error: 'Token mangler.' }, 400, cors);

  const hash = await sha256Hex(rawToken);
  // Atomisk engangsbruk: RETURNING gir oss bruker_id i samme kall som
  // markerer token brukt — ingen separat les-så-skriv-race.
  const rad = await env.DB.prepare(
    `UPDATE innloggingstokens SET brukt = 1
     WHERE hash = ?1 AND brukt = 0 AND utloper > ?2
     RETURNING bruker_id`
  )
    .bind(hash, Date.now())
    .first();

  if (!rad) {
    return json({ error: 'Lenken er ugyldig, utløpt, eller allerede brukt.' }, 400, cors);
  }

  const sesjonToken = await opprettSesjon(rad.bruker_id, env);

  return new Response(null, {
    status: 302,
    headers: {
      Location: env.ALLOWED_ORIGIN,
      'Set-Cookie': sesjonCookieHeader(sesjonToken),
      ...cors,
    },
  });
}

export async function loggUt({ request, env }) {
  const cors = corsHeaders(env);
  await slettSesjon(request, env);
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': slettSesjonCookieHeader(), ...cors },
  });
}

async function tidsnormaliser(startTid) {
  const gjenstaende = MAALTID_MS - (Date.now() - startTid);
  if (gjenstaende > 0) await new Promise((r) => setTimeout(r, gjenstaende));
}
