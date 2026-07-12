import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireAdmin } from '../lib/session.js';
import { erFunnSynligForPublic, settFunnSynligForPublic } from '../lib/innstillinger.js';

export async function listBrukere({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const { results } = await env.DB.prepare(
    `SELECT id, epost, kortnavn, rolle, status, slettet_tidspunkt, opprettet
     FROM brukere ORDER BY opprettet`
  ).all();
  return json(results, 200, cors);
}

export async function oppdaterBrukerStatus({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const id = parseInt(params.id, 10);
  if (id === admin.id) return json({ error: 'Du kan ikke endre din egen konto her.' }, 400, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }
  if (body.status !== 'aktiv' && body.status !== 'deaktivert') {
    return json({ error: 'Ugyldig status.' }, 400, cors);
  }

  const rad = await env.DB.prepare('SELECT slettet_tidspunkt FROM brukere WHERE id = ?').bind(id).first();
  if (!rad) return json({ error: 'Fant ikke bruker.' }, 404, cors);
  if (rad.slettet_tidspunkt) return json({ error: 'Bruker er permanent slettet.' }, 400, cors);

  await env.DB.prepare('UPDATE brukere SET status = ? WHERE id = ?').bind(body.status, id).run();

  // Umiddelbar tilbaketrekking ved deaktivering — ikke bare sperre fremtidig
  // innlogging, samme prinsipp som requireSession()s status-sjekk.
  if (body.status === 'deaktivert') {
    await env.DB.prepare('DELETE FROM sesjoner WHERE bruker_id = ?').bind(id).run();
  }

  return json({ ok: true }, 200, cors);
}

export async function slettBrukerPermanent({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const id = parseInt(params.id, 10);
  if (id === admin.id) return json({ error: 'Du kan ikke slette din egen konto her.' }, 400, cors);

  const rad = await env.DB.prepare('SELECT slettet_tidspunkt FROM brukere WHERE id = ?').bind(id).first();
  if (!rad) return json({ error: 'Fant ikke bruker.' }, 404, cors);
  if (rad.slettet_tidspunkt) return json({ error: 'Bruker er allerede permanent slettet.' }, 400, cors);

  // Scrubber e-post i stedet for å slette raden — se migrations/0003 og
  // Milestone C-planen for hvorfor (unngår å bryte funn sin fremmednøkkel).
  const plassholderEpost = `slettet-${id}@slettet.invalid`;
  await env.DB.prepare(
    `UPDATE brukere SET epost = ?, status = 'deaktivert', slettet_tidspunkt = datetime('now') WHERE id = ?`
  )
    .bind(plassholderEpost, id)
    .run();
  await env.DB.prepare('DELETE FROM sesjoner WHERE bruker_id = ?').bind(id).run();

  return json({ ok: true }, 200, cors);
}

export async function hentInnstillinger({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  return json({ funnSynligForPublic: await erFunnSynligForPublic(env) }, 200, cors);
}

export async function oppdaterInnstillinger({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }
  if (typeof body.funnSynligForPublic !== 'boolean') {
    return json({ error: 'Ugyldig verdi for funnSynligForPublic.' }, 400, cors);
  }

  await settFunnSynligForPublic(env, body.funnSynligForPublic);
  return json({ funnSynligForPublic: body.funnSynligForPublic }, 200, cors);
}
