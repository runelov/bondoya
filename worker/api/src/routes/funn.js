import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';
import { parseFunnRad, hentFunnRad, validerFunnFelter, lastOppBildeHvisTilstede } from '../lib/funn.js';
import { erFunnSynligForPublic } from '../lib/innstillinger.js';

export async function listFunn({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  const { results } = await env.DB.prepare('SELECT * FROM funn ORDER BY tidspunkt DESC').all();
  return json(results.map((rad) => parseFunnRad(rad, bruker)), 200, cors);
}

export async function opprettFunn({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  let felter;
  let bildeKey;
  try {
    felter = await validerFunnFelter(Object.fromEntries(formData.entries()), env);
    bildeKey = await lastOppBildeHvisTilstede(formData, bruker.id, env);
  } catch (e) {
    return json({ error: e.message }, 400, cors);
  }

  const rad = await env.DB.prepare(
    `INSERT INTO funn (
       art_norsk, art_latinsk, art_taxon_id, artstype, lat, lon, tidspunkt,
       bilde_r2_key, ki_konfidens, ki_alternativer,
       registrert_av_bruker_id, registrert_av_kortnavn, synlig_for_public
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  )
    .bind(
      felter.artNorsk,
      felter.artLatinsk,
      felter.artTaxonId,
      felter.artstype,
      felter.lat,
      felter.lon,
      felter.tidspunkt,
      bildeKey,
      felter.kiKonfidens,
      felter.kiAlternativer,
      bruker.id,
      bruker.kortnavn,
      felter.synligForPublic ? 1 : 0
    )
    .first();

  return json(parseFunnRad(rad, bruker), 201, cors);
}

export async function oppdaterFunn({ request, env, params }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  const eksisterende = await hentFunnRad(params.id, env);
  if (!eksisterende) return json({ error: 'Fant ikke funnet.' }, 404, cors);
  if (eksisterende.registrert_av_bruker_id !== bruker.id) {
    return json({ error: 'Du kan kun redigere dine egne funn.' }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ugyldig forespørsel.' }, 400, cors);
  }

  let felter;
  try {
    felter = await validerFunnFelter(body, env);
  } catch (e) {
    return json({ error: e.message }, 400, cors);
  }

  const rad = await env.DB.prepare(
    `UPDATE funn SET
       art_norsk = ?, art_latinsk = ?, art_taxon_id = ?, artstype = ?,
       lat = ?, lon = ?, tidspunkt = ?, synlig_for_public = ?
     WHERE id = ?
     RETURNING *`
  )
    .bind(
      felter.artNorsk,
      felter.artLatinsk,
      felter.artTaxonId,
      felter.artstype,
      felter.lat,
      felter.lon,
      felter.tidspunkt,
      felter.synligForPublic ? 1 : 0,
      params.id
    )
    .first();

  return json(parseFunnRad(rad, bruker), 200, cors);
}

export async function slettFunn({ request, env, params }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

  const eksisterende = await hentFunnRad(params.id, env);
  if (!eksisterende) return json({ error: 'Fant ikke funnet.' }, 404, cors);
  // Admin kan slette hvilket som helst funn (moderasjon av upassende
  // innhold) — se konsept.md "Admin-moderasjon". Rediger (oppdaterFunn over)
  // har bevisst ingen tilsvarende admin-unntak, kun sletting.
  if (eksisterende.registrert_av_bruker_id !== bruker.id && bruker.rolle !== 'admin') {
    return json({ error: 'Du kan kun slette dine egne funn.' }, 403, cors);
  }

  if (eksisterende.bilde_r2_key) await env.IMAGES.delete(eksisterende.bilde_r2_key);
  await env.DB.prepare('DELETE FROM funn WHERE id = ?').bind(params.id).run();

  return new Response(null, { status: 204, headers: cors });
}

export async function hentBilde({ request, env, ctx, params }) {
  const cors = corsHeaders(env);

  const rad = await hentFunnRad(params.id, env);
  if (!rad || !rad.bilde_r2_key) return json({ error: 'Fant ikke bilde.' }, 404, cors);

  // Bilder til offentlig-synlige funn serveres uinnlogget (samme skille som
  // listFunn/listFunnOffentlig) — men kun når den globale admin-bryteren for
  // offentlig funnvisning faktisk er PÅ (se lib/innstillinger.js). Alt annet
  // krever sesjon som før.
  const offentligPa = rad.synlig_for_public && (await erFunnSynligForPublic(env));
  if (!offentligPa) {
    const bruker = await requireSession(request, env);
    if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);

    const objekt = await env.IMAGES.get(rad.bilde_r2_key);
    if (!objekt) return json({ error: 'Fant ikke bilde.' }, 404, cors);
    // Privat (kun nettleserens egen cache) — riktig så lenge tilgangen er
    // sesjonsavhengig. Lang levetid er trygt her: det er brukerens eget
    // bilde av eget/tilgjengelig funn, ikke noe delt.
    return new Response(objekt.body, {
      status: 200,
      headers: {
        'Content-Type': objekt.httpMetadata?.contentType || 'image/jpeg',
        'Cache-Control': 'private, max-age=31536000',
        ...cors,
      },
    });
  }

  // Offentlig synlig funn: bildet kan caches DELT (Cloudflares edge), ikke
  // bare i den enkelte nettleser — dette var tidligere `private` uansett
  // gren, som forhindret enhver edge-caching og tvang hvert visnings-kall
  // (fra hver besøkende) helt til R2 (tilbakemelding 2026-07-16: "Caching av
  // funn-thumbnails, Cloudflare og nettleser-innstillinger"). En vanlig
  // Workers-respons caches ikke automatisk av Cloudflares CDN kun fordi
  // Cache-Control sier public — krever eksplisitt bruk av Cache API slik som
  // her (uten en Cache Rule i dashbordet). Kortere levetid enn den private
  // grenen (1 time, ikke 1 år): begrenser hvor lenge et allerede-cachet bilde
  // kan henge igjen i Cloudflares edge dersom admin siden skjuler arten eller
  // skrur av offentlig funnvisning — det finnes ingen purge-mekanisme for det.
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const cachetSvar = await cache.match(cacheKey);
  if (cachetSvar) return cachetSvar;

  const objekt = await env.IMAGES.get(rad.bilde_r2_key);
  if (!objekt) return json({ error: 'Fant ikke bilde.' }, 404, cors);

  const svar = new Response(objekt.body, {
    status: 200,
    headers: {
      'Content-Type': objekt.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
      ...cors,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, svar.clone()));
  return svar;
}
