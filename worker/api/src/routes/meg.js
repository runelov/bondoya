import { json } from '../lib/json.js';
import { corsHeaders } from '../lib/cors.js';
import { requireSession } from '../lib/session.js';
import { beregnFremdrift } from '../lib/fremdrift.js';
import { erLeaderboardAktivert } from '../lib/innstillinger.js';

// Svarer alltid 200 — dette er en statussjekk, ikke en beskyttet ressurs.
// "Ikke innlogget" er et normalt, forventet svar (appstart, enhver
// offentlig besøkende), ikke en feilsituasjon som fortjener 401. Med 401
// her logget nettleserens DevTools en rød konsollfeil for HVER offentlig
// besøkende, uavhengig av at klienten selv håndterte det helt fint — se
// js/api-client.js sin meg().
export async function meg({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  // leaderboardAktivert sendes MED uansett innloggingsstatus — samme
  // "lett flagg appen uansett henter ved oppstart"-mønster som
  // offentlig/innstillinger bruker for funnSynligForPublic, se konsept.md
  // "Fase D — Leaderboard". Selve /leaderboard-endepunktet krever likevel
  // innlogging (requireSession) — flagget her styrer kun om klienten viser
  // inngangen, ikke tilgang til dataene.
  const leaderboardAktivert = await erLeaderboardAktivert(env);
  if (!bruker) return json({ loggedIn: false, leaderboardAktivert }, 200, cors);
  return json(
    { loggedIn: true, epost: bruker.epost, kortnavn: bruker.kortnavn, rolle: bruker.rolle, leaderboardAktivert },
    200,
    cors
  );
}

// I MOTSETNING til meg() over: dette er en beskyttet ressurs (brukerens
// egne poeng/badges/fremdrift), ikke en statussjekk — vanlig 401 her, ikke
// {loggedIn:false}+200-mønsteret som er spesifikt for den bare
// status-sjekken. Se lib/fremdrift.js for hele beregningen.
export async function hentFremdrift({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);
  return json(await beregnFremdrift(bruker.id, env), 200, cors);
}

// Fase D — leaderboard, se konsept.md "Gamification". Krever innlogging
// (ikke admin), og krever i tillegg at admin har skrudd funksjonen PÅ
// (erLeaderboardAktivert — fail-closed, se lib/innstillinger.js). 403 på
// samme måte som requireAdmin gir 403 andre steder, ikke en tom liste —
// klienten skal uansett ha skjult inngangen via meg() sitt flagg, en 403
// her er et bakstopp for noen som kaller endepunktet direkte.
//
// Gjenbruker beregnFremdrift() PER aktiv bruker (samme funksjon som
// hentFremdrift()/hentAdminFremdrift() i routes/admin.js), men returnerer
// et bevisst SMALERE felt-sett enn admin-oversikten: ingen brukerId, ingen
// status, ingen deaktiverte brukere, og kun OPPNÅDDE merker (nøkkel+navn,
// ikke beskrivelse/progresjon) — se konsept.md for hvorfor (merkenes
// beskrivelsestekst kan navngi hvilken rødlistet art brukeren fant).
export async function hentLeaderboard({ request, env }) {
  const cors = corsHeaders(env);
  const bruker = await requireSession(request, env);
  if (!bruker) return json({ error: 'Ikke innlogget.' }, 401, cors);
  if (!(await erLeaderboardAktivert(env))) {
    return json({ error: 'Leaderboard er ikke aktivert.' }, 403, cors);
  }

  const { results: brukere } = await env.DB.prepare(
    `SELECT id, kortnavn FROM brukere WHERE slettet_tidspunkt IS NULL AND status = 'aktiv' ORDER BY kortnavn`
  ).all();

  const rangering = await Promise.all(
    brukere.map(async (b) => {
      const f = await beregnFremdrift(b.id, env);
      return {
        kortnavn: b.kortnavn,
        poengsum: f.score.totalt,
        antallArter: f.antallArter,
        merker: f.badges.filter((m) => m.opptjent).map((m) => ({ nokkel: m.nokkel, navn: m.navn })),
      };
    })
  );

  rangering.sort((a, b) => b.poengsum - a.poengsum);
  return json(rangering, 200, cors);
}
