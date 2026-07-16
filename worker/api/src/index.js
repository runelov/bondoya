import { createRouter } from './router.js';
import { corsHeaders } from './lib/cors.js';
import { json } from './lib/json.js';
import { rullerSesjonHvisNodvendig, sesjonCookieHeader } from './lib/session.js';
import { beOmLenke, verifiser, loggUt } from './routes/auth.js';
import { meg } from './routes/meg.js';
import { listFunn, opprettFunn, oppdaterFunn, slettFunn, hentBilde } from './routes/funn.js';
import {
  listBrukere, oppdaterBrukerStatus, slettBrukerPermanent, hentInnstillinger, oppdaterInnstillinger,
  listAdminSider, opprettSide, oppdaterSide, slettSide,
  listInvitasjoner, opprettInvitasjon, slettInvitasjon,
  listSkjulteArter, skjulArt, visArtIgjen,
  settArtsbeskrivelse,
  hentDashboard,
} from './routes/admin.js';
import { listFunnOffentlig, hentOffentligInnstillinger } from './routes/offentlig.js';
import { hentFlis } from './routes/tiles.js';
import { listSider, hentSide } from './routes/sider.js';
import { sjekkInvitasjon, registrerMedInvitasjon } from './routes/invitasjoner.js';
import { sokArter, hentArtsbeskrivelse } from './routes/arter.js';
import { gjenkjennArt } from './routes/ki.js';

const router = createRouter();
router.post('/auth/be-om-lenke', beOmLenke);
router.get('/auth/verifiser', verifiser);
router.post('/auth/logg-ut', loggUt);
router.get('/meg', meg);
router.get('/funn', listFunn);
router.post('/funn', opprettFunn);
router.patch('/funn/:id', oppdaterFunn);
router.delete('/funn/:id', slettFunn);
router.get('/funn/bilde/:id', hentBilde);
router.get('/funn/offentlig', listFunnOffentlig);
router.get('/offentlig/innstillinger', hentOffentligInnstillinger);
router.get('/tiles/:z/:x/:y', hentFlis);
router.get('/arter/sok', sokArter);
router.get('/arter/:taxonId/beskrivelse', hentArtsbeskrivelse);
router.patch('/admin/arter/:taxonId/beskrivelse', settArtsbeskrivelse);
router.post('/ki/gjenkjenn', gjenkjennArt);
router.get('/admin/brukere', listBrukere);
router.patch('/admin/brukere/:id', oppdaterBrukerStatus);
router.delete('/admin/brukere/:id', slettBrukerPermanent);
router.get('/admin/innstillinger', hentInnstillinger);
router.patch('/admin/innstillinger', oppdaterInnstillinger);
router.get('/sider', listSider);
router.get('/sider/:slug', hentSide);
router.get('/admin/sider', listAdminSider);
router.post('/admin/sider', opprettSide);
router.patch('/admin/sider/:id', oppdaterSide);
router.delete('/admin/sider/:id', slettSide);
router.get('/invitasjon/:token', sjekkInvitasjon);
router.post('/invitasjon/:token', registrerMedInvitasjon);
router.get('/admin/invitasjoner', listInvitasjoner);
router.post('/admin/invitasjoner', opprettInvitasjon);
router.delete('/admin/invitasjoner/:id', slettInvitasjon);
router.get('/admin/skjulte-arter', listSkjulteArter);
router.post('/admin/skjulte-arter', skjulArt);
router.delete('/admin/skjulte-arter/:taxonId', visArtIgjen);
router.get('/admin/dashboard', hentDashboard);

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Speiler worker/ki-proxy: fang alt herfra, gi JSON tilbake i stedet
    // for Cloudflares generiske feilside.
    let res;
    try {
      res = await router.handle(request, env, ctx);
      if (!res) res = json({ error: 'Ikke funnet.' }, 404, cors);
    } catch (e) {
      console.error(e);
      res = json({ error: 'Uventet feil.' }, 500, cors);
    }
    return leggTilRullertSesjonCookie(request, env, res);
  },
};

// Periodisk sesjonstoken-rotasjon (se lib/session.js sin
// rullerSesjonHvisNodvendig) — sentralt her i stedet for i hver enkelt rute,
// slik at IKKE hver av de ~20 route-filene selv må huske å legge på en ny
// Set-Cookie. Kjøres etter at requestens EGEN autentisering (inne i
// router.handle) allerede har brukt det gamle tokenet ferdig, så denne
// forespørselen påvirkes aldri av rulleringen — kun neste.
async function leggTilRullertSesjonCookie(request, env, response) {
  const rullert = await rullerSesjonHvisNodvendig(request, env);
  if (!rullert) return response;

  const maxAgeSekunder = (rullert.utloper - Date.now()) / 1000;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', sesjonCookieHeader(rullert.token, maxAgeSekunder));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
