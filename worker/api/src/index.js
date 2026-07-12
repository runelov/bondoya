import { createRouter } from './router.js';
import { corsHeaders } from './lib/cors.js';
import { json } from './lib/json.js';
import { beOmLenke, verifiser, loggUt } from './routes/auth.js';
import { meg } from './routes/meg.js';
import { listFunn, opprettFunn, oppdaterFunn, slettFunn, hentBilde } from './routes/funn.js';
import { listBrukere, oppdaterBrukerStatus, slettBrukerPermanent } from './routes/admin.js';
import { listFunnOffentlig } from './routes/offentlig.js';
import { hentFlis } from './routes/tiles.js';

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
router.get('/tiles/:z/:x/:y', hentFlis);
router.get('/admin/brukere', listBrukere);
router.patch('/admin/brukere/:id', oppdaterBrukerStatus);
router.delete('/admin/brukere/:id', slettBrukerPermanent);

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Speiler worker/ki-proxy: fang alt herfra, gi JSON tilbake i stedet
    // for Cloudflares generiske feilside.
    try {
      const res = await router.handle(request, env, ctx);
      if (res) return res;
      return json({ error: 'Ikke funnet.' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: 'Uventet feil.' }, 500, cors);
    }
  },
};
