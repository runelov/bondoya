import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireAdmin } from '../lib/session.js';
import { erFunnSynligForPublic, settFunnSynligForPublic } from '../lib/innstillinger.js';
import { parseSideRad, validerSideFelter } from '../lib/sider.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { validerEpost } from '../lib/invitasjoner.js';

export async function listBrukere({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const { results } = await env.DB.prepare(
    `SELECT id, epost, kortnavn, rolle, status, slettet_tidspunkt, aktivert_tidspunkt, opprettet
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

export async function listAdminSider({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const { results } = await env.DB.prepare('SELECT * FROM sider ORDER BY tittel').all();
  return json(results.map(parseSideRad), 200, cors);
}

export async function opprettSide({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  let felter;
  try {
    felter = validerSideFelter(body);
  } catch (e) {
    return json({ error: e.message }, 400, cors);
  }

  let rad;
  try {
    rad = await env.DB.prepare(
      `INSERT INTO sider (slug, tittel, innhold, synlighet, status) VALUES (?, ?, ?, ?, ?) RETURNING *`
    )
      .bind(felter.slug, felter.tittel, felter.innhold, felter.synlighet, felter.status)
      .first();
  } catch (e) {
    return json({ error: 'Slug er allerede i bruk.' }, 400, cors);
  }

  return json(parseSideRad(rad), 201, cors);
}

export async function oppdaterSide({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  let felter;
  try {
    felter = validerSideFelter(body);
  } catch (e) {
    return json({ error: e.message }, 400, cors);
  }

  let rad;
  try {
    rad = await env.DB.prepare(
      `UPDATE sider SET slug = ?, tittel = ?, innhold = ?, synlighet = ?, status = ?, oppdatert = datetime('now')
       WHERE id = ? RETURNING *`
    )
      .bind(felter.slug, felter.tittel, felter.innhold, felter.synlighet, felter.status, params.id)
      .first();
  } catch (e) {
    return json({ error: 'Slug er allerede i bruk.' }, 400, cors);
  }
  if (!rad) return json({ error: 'Fant ikke siden.' }, 404, cors);

  return json(parseSideRad(rad), 200, cors);
}

export async function slettSide({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const rad = await env.DB.prepare('SELECT id FROM sider WHERE id = ?').bind(params.id).first();
  if (!rad) return json({ error: 'Fant ikke siden.' }, 404, cors);

  await env.DB.prepare('DELETE FROM sider WHERE id = ?').bind(params.id).run();
  return new Response(null, { status: 204, headers: cors });
}

const INVITASJON_LEVETID_MS = 7 * 24 * 60 * 60 * 1000; // 7 dager

export async function listInvitasjoner({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const { results } = await env.DB.prepare(
    `SELECT i.id, i.epost, i.brukt, i.utloper, i.opprettet,
            opp.kortnavn AS opprettet_av_kortnavn,
            bru.kortnavn AS brukt_av_kortnavn
     FROM invitasjoner i
     JOIN brukere opp ON opp.id = i.opprettet_av_bruker_id
     LEFT JOIN brukere bru ON bru.id = i.brukt_av_bruker_id
     ORDER BY i.opprettet DESC`
  ).all();
  return json(results, 200, cors);
}

// Krever nå e-post ved generering (sikkerhetsfiks, se lib/invitasjoner.js):
// lenken bindes til én bestemt adresse admin selv oppgir, ikke lenger noe
// den som klikker lenken kan velge fritt ved registrering.
export async function opprettInvitasjon({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  let epost;
  try {
    epost = validerEpost(body.epost);
  } catch (e) {
    return json({ error: e.message }, 400, cors);
  }

  const rawToken = randomToken();
  const hash = await sha256Hex(rawToken);
  const utloper = Date.now() + INVITASJON_LEVETID_MS;

  const rad = await env.DB.prepare(
    `INSERT INTO invitasjoner (token_hash, epost, opprettet_av_bruker_id, utloper) VALUES (?, ?, ?, ?) RETURNING id`
  )
    .bind(hash, epost, admin.id, utloper)
    .first();

  // Rå token returneres kun i DETTE svaret — bare hashen lagres, samme
  // "vises kun nå"-prinsipp som magic-link-tokens (lib/session.js).
  return json({ id: rad.id, token: rawToken, epost, utloper }, 201, cors);
}

export async function slettInvitasjon({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const rad = await env.DB.prepare('SELECT brukt FROM invitasjoner WHERE id = ?').bind(params.id).first();
  if (!rad) return json({ error: 'Fant ikke invitasjonen.' }, 404, cors);
  if (rad.brukt) return json({ error: 'Kan ikke trekke tilbake en invitasjon som allerede er brukt.' }, 400, cors);

  await env.DB.prepare('DELETE FROM invitasjoner WHERE id = ?').bind(params.id).run();
  return new Response(null, { status: 204, headers: cors });
}

export async function listSkjulteArter({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const { results } = await env.DB.prepare('SELECT * FROM skjulte_arter ORDER BY visningsnavn').all();
  return json(results, 200, cors);
}

export async function skjulArt({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  const taxonId = parseInt(body.taxonId, 10);
  if (!Number.isFinite(taxonId) || taxonId <= 0) return json({ error: 'Ugyldig taxonId.' }, 400, cors);

  const visningsnavn = (body.visningsnavn || '').trim();
  if (!visningsnavn) return json({ error: 'Visningsnavn mangler.' }, 400, cors);
  if (visningsnavn.length > 200) return json({ error: 'Visningsnavn er for langt.' }, 400, cors);

  const grunn = (body.grunn || '').trim() || null;
  if (grunn && grunn.length > 500) return json({ error: 'Grunn er for lang.' }, 400, cors);

  let rad;
  try {
    rad = await env.DB.prepare(
      `INSERT INTO skjulte_arter (taxon_id, visningsnavn, grunn, lagt_til_av_bruker_id)
       VALUES (?, ?, ?, ?) RETURNING *`
    )
      .bind(taxonId, visningsnavn, grunn, admin.id)
      .first();
  } catch (e) {
    return json({ error: 'Denne arten er allerede skjult.' }, 400, cors);
  }

  // Retroaktiv skjuling — se plan-notatet: hele poenget med å skjule en art
  // manuelt (f.eks. en sensitiv lokalitet) forsvinner hvis allerede
  // registrerte funn av den arten forblir synlige.
  await env.DB.prepare('UPDATE funn SET synlig_for_public = 0 WHERE art_taxon_id = ?').bind(taxonId).run();

  return json(rad, 201, cors);
}

// Admin-skrevet artsomtale er alltid autoritativ og overskriver en
// eventuell tidligere Wikipedia-hentet rad for samme taxonId (se
// migrations/0015 og hentArtsbeskrivelse i routes/arter.js).
export async function settArtsbeskrivelse({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const taxonId = parseInt(params.taxonId, 10);
  if (!Number.isFinite(taxonId) || taxonId <= 0) return json({ error: 'Ugyldig taxonId.' }, 400, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  const beskrivelse = (body.beskrivelse || '').trim();
  if (!beskrivelse) return json({ error: 'Beskrivelse mangler.' }, 400, cors);
  if (beskrivelse.length > 2000) return json({ error: 'Beskrivelse er for lang.' }, 400, cors);

  await env.DB.prepare(
    `INSERT INTO arter_metadata (taxon_id, beskrivelse, kilde, wikipedia_url, oppdatert_av_bruker_id, oppdatert)
     VALUES (?, ?, 'admin', NULL, ?, datetime('now'))
     ON CONFLICT(taxon_id) DO UPDATE SET
       beskrivelse = excluded.beskrivelse, kilde = 'admin', wikipedia_url = NULL,
       oppdatert_av_bruker_id = excluded.oppdatert_av_bruker_id, oppdatert = datetime('now')`
  ).bind(taxonId, beskrivelse, admin.id).run();

  return json({ taxonId, beskrivelse, kilde: 'admin' }, 200, cors);
}

export async function visArtIgjen({ request, env, params }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const taxonId = parseInt(params.taxonId, 10);
  const rad = await env.DB.prepare('SELECT taxon_id FROM skjulte_arter WHERE taxon_id = ?').bind(taxonId).first();
  if (!rad) return json({ error: 'Fant ikke arten i skjult-listen.' }, 404, cors);

  await env.DB.prepare('DELETE FROM skjulte_arter WHERE taxon_id = ?').bind(taxonId).run();
  // Retroaktivt motsatt av skjulArt() over — en kjent taxonId uten noen
  // blokkeringsrad er per definisjon synlig, se lib/artsvisibility.js.
  await env.DB.prepare('UPDATE funn SET synlig_for_public = 1 WHERE art_taxon_id = ?').bind(taxonId).run();

  return new Response(null, { status: 204, headers: cors });
}

// Ren lesing/aggregering av eksisterende tabeller — ingen ny migrasjon.
// Kun bruksstatistikk (avklart med produkteier); kostnadsbilde per tjeneste
// (Cloudflare/Mapbox/Anthropic, nevnt som "hvis mulig" i konsept.md) er
// bevisst utelatt — ville krevd egne faktureringsAPI-hemmeligheter.
export async function hentDashboard({ request, env }) {
  const cors = corsHeaders(env);
  const admin = await requireAdmin(request, env);
  if (!admin) return json({ error: 'Krever admin-tilgang.' }, 403, cors);

  const now = Date.now();
  const naa = new Date();
  // tidspunkt er alltid en ISO 8601 UTC-streng (se migrations/0002) — trygt
  // å sammenligne leksikografisk mot en annen ISO-streng.
  const starenAvManeden = new Date(Date.UTC(naa.getUTCFullYear(), naa.getUTCMonth(), 1)).toISOString();

  const [
    brukerTelling,
    funnTelling,
    funnPerArtstype,
    toppBidragsytere,
    siderPerStatus,
    invitasjonTelling,
    skjulteArterTelling,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS totalt,
              COALESCE(SUM(CASE WHEN status = 'aktiv' THEN 1 ELSE 0 END), 0) AS aktive,
              COALESCE(SUM(CASE WHEN status = 'deaktivert' THEN 1 ELSE 0 END), 0) AS deaktiverte,
              COALESCE(SUM(CASE WHEN rolle = 'admin' THEN 1 ELSE 0 END), 0) AS admins
       FROM brukere WHERE slettet_tidspunkt IS NULL`
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS totalt,
              COALESCE(SUM(CASE WHEN tidspunkt >= ?1 THEN 1 ELSE 0 END), 0) AS denneManeden,
              COALESCE(SUM(CASE WHEN synlig_for_public = 1 THEN 1 ELSE 0 END), 0) AS offentligSynlig
       FROM funn`
    ).bind(starenAvManeden).first(),
    env.DB.prepare('SELECT artstype, COUNT(*) AS antall FROM funn GROUP BY artstype ORDER BY antall DESC').all(),
    env.DB.prepare(
      `SELECT registrert_av_kortnavn AS kortnavn, COUNT(*) AS antall
       FROM funn GROUP BY registrert_av_bruker_id ORDER BY antall DESC LIMIT 5`
    ).all(),
    env.DB.prepare('SELECT status, COUNT(*) AS antall FROM sider GROUP BY status').all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS totalt,
              COALESCE(SUM(CASE WHEN brukt = 1 THEN 1 ELSE 0 END), 0) AS brukt,
              COALESCE(SUM(CASE WHEN brukt = 0 AND utloper > ?1 AND epost IS NOT NULL THEN 1 ELSE 0 END), 0) AS ubruktGyldig,
              COALESCE(SUM(CASE WHEN brukt = 0 AND (utloper <= ?1 OR epost IS NULL) THEN 1 ELSE 0 END), 0) AS utlopt
       FROM invitasjoner`
    ).bind(now).first(),
    env.DB.prepare('SELECT COUNT(*) AS totalt FROM skjulte_arter').first(),
  ]);

  const sidePublisert = siderPerStatus.results.find((r) => r.status === 'publisert')?.antall || 0;
  const sideKladd = siderPerStatus.results.find((r) => r.status === 'kladd')?.antall || 0;

  return json(
    {
      brukere: brukerTelling,
      funn: {
        totalt: funnTelling.totalt,
        denneManeden: funnTelling.denneManeden,
        offentligSynlig: funnTelling.offentligSynlig,
        perArtstype: funnPerArtstype.results,
        toppBidragsytere: toppBidragsytere.results,
      },
      sider: { totalt: sidePublisert + sideKladd, publisert: sidePublisert, kladd: sideKladd },
      invitasjoner: invitasjonTelling,
      skjulteArter: skjulteArterTelling.totalt,
    },
    200,
    cors
  );
}
