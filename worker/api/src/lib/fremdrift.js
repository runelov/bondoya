import { ARTSTYPER, RODLISTE_LABELS } from './taxonomi.js';
import { finnOy } from './oyer.js';

// Fase A — personlig fremdrift (poeng, badges, artstype-dekning, øyhopper),
// se konsept.md "Gamification: personlig fremdrift, poeng og badges".
// Beregnes on-the-fly ved hver forespørsel (ingen ny poeng-/badge-tabell)
// — eksplisitt v1-beslutning i konsept.md, billig på denne skalaen
// (10-15 brukere, noen hundre funn).
//
// Sjeldenhet (se lengre ned) ble lagt til 2026-08-28 — datagrunnlaget
// (REFERANSEDATA-cachen) var lenge klart, men selve vektingen inn i
// poengsummen var bevisst utsatt til etter Fase D (leaderboard), se
// konsept.md "Sjeldenhet i poengmodellen — vurdering".

// Ingen av disse tallene (utover 1p/registrering og 3p/ny art, som er gitt
// direkte i konsept.md sin Poengmodell-tabell) er spesifisert numerisk der —
// foreslåtte startverdier, samlet ett sted for lett retuning senere.
// Rødliste-trappetrinnene er NT < VU < EN/CR (EN og CR deler toppen), jf.
// konsept.md sin egen ordlyd i tabellen.
const POENG = {
  REGISTRERING: 1,
  NY_ART: 3,
  NY_ARTSTYPE: 10,
  RODLISTE: { NT: 5, VU: 10, EN: 20, CR: 20 },
  SJELDENHET: { svaert_sjelden: 15, sjelden: 8, mindre_vanlig: 3 },
  OPPDAGER: 25,
  OYHOPPER_PER_EKSTRA_KLYNGE: 15,
};

// Trappetrinn (ikke kontinuerlig invers-frekvens-formel — se vurderingen i
// konsept.md for hvorfor: en rå K/frekvens-formel gir absurde utslag for en
// art med kun 1 observasjon totalt). Terskler = antall observasjoner i den
// lokale, 40 km-avgrensede Artskart-cachen (REFERANSEDATA-KV,
// `bondoya-db/scripts/fetch_artskart.py`, oppdatert ukentlig, 289 arter per
// 2026-08-28). En art som ikke finnes i cachen i det hele tatt (verken
// registrert lokalt, eller genuint ikke i kandidatlista) behandles som
// "vanlig" (0p) — IKKE som "sjeldnest mulig". Bevisst valg, se vurderingen:
// motsatt ville gjort det trivielt å score høyt bare ved å finne noe
// utenfor kandidatlista, uavhengig av faktisk sjeldenhet, og det ekte
// alternativet (live oppslag mot Artsdatabanken per ikke-cachet art) ble
// vurdert og forkastet av ytelsesgrunner — se samme sted i konsept.md.
const SJELDENHET_TERSKLER = { SVAERT_SJELDEN: 5, SJELDEN: 20, MINDRE_VANLIG: 100 };
const REFERANSEDATA_NOKKEL = 'lokale-observasjoner'; // samme nøkkel som routes/artskart.js

function sjeldenhetKategori(frekvens) {
  if (frekvens == null) return 'vanlig'; // ikke i cachen — se toppkommentar
  if (frekvens <= SJELDENHET_TERSKLER.SVAERT_SJELDEN) return 'svaert_sjelden';
  if (frekvens <= SJELDENHET_TERSKLER.SJELDEN) return 'sjelden';
  if (frekvens <= SJELDENHET_TERSKLER.MINDRE_VANLIG) return 'mindre_vanlig';
  return 'vanlig';
}

// Ett KV-kall per beregnFremdrift()-kall (altså ett per bruker når
// GET /leaderboard eller GET /admin/fremdrift kaller den i en løkke) — bevisst
// ikke delt/cachet på tvers av kallene i denne omgangen. KV-lesing er billig
// nok til at N kall på denne skalaen (10-15 brukere) ikke er verdt
// kompleksiteten det ville tatt å sende et forhåndshentet kart inn som
// parameter i stedet — revurder kun hvis dette faktisk viser seg tregt i
// praksis, se samme resonnement i konsept.md sin vurdering.
async function hentFrekvensTabell(env) {
  const frekvens = new Map();
  if (!env.REFERANSEDATA) return frekvens; // ikke bundet lokalt i alle dev-oppsett
  let lagret;
  try {
    lagret = await env.REFERANSEDATA.get(REFERANSEDATA_NOKKEL);
  } catch {
    return frekvens; // fail-closed: ingen sjeldenhetsbonus er tryggere enn å knekke hele fremdriftssiden
  }
  if (!lagret) return frekvens;
  let data;
  try {
    data = JSON.parse(lagret);
  } catch {
    return frekvens;
  }
  for (const o of data.observasjoner || []) {
    if (o.taxonId == null) continue;
    frekvens.set(o.taxonId, (frekvens.get(o.taxonId) || 0) + 1);
  }
  return frekvens;
}

// Norsk tekst for antall sjeldne/svært sjeldne arter — kun de to
// badge-relevante trinnene (ikke "mindre vanlig", som gir poeng men ikke
// regnes som "sjelden" i vanlig forstand her), se scoreelementets detalj
// og sjeldenhetsjeger-merket lengre ned.
function beskrivSjeldneArter(sjeldneArter) {
  const svaert = sjeldneArter.filter((a) => a.kategori === 'svaert_sjelden').length;
  const sjelden = sjeldneArter.filter((a) => a.kategori === 'sjelden').length;
  const deler = [];
  if (svaert > 0) deler.push(`${svaert} svært ${svaert === 1 ? 'sjelden' : 'sjeldne'}`);
  if (sjelden > 0) deler.push(`${sjelden} ${sjelden === 1 ? 'sjelden' : 'sjeldne'}`);
  return deler.length ? deler.join(', ') : 'ingen sjeldne arter ennå';
}

const ARTSSAMLER_TERSKLER = [10, 25, 50];
// Beskrivende navn i stedet for "Artssamler I/II/III" — produkttilbakemelding
// 2026-08-13 fant at tallnavngivingen kolliderte med medaljeikonenes egne
// trykte tall i klienten (🥉 har "3" trykt på seg, 🥇 har "1" — stikk
// motsatt av "I"/"III"). Vanskelighetsgraden formidles nå i selve ordet,
// uavhengig av hvilket ikon klienten velger å vise ved siden av.
const ARTSSAMLER_NAVN = ['Artssamler', 'Ivrig artssamler', 'Artsmester'];

// Norsk tekst for en liste besøkte øyer, delt mellom scoreelementets
// detalj-tekst og de to Øyhopper-merkenes beskrivelse — se lib/oyer.js
// for selve punkt-i-polygon-oppslaget. "et navnløst skjær"/"N navnløse
// skjær" for øyer uten offisielt navn (10 av 27, se
// scripts/hent-oyer.mjs) — bevisst fortsatt talt med, bare uten navn,
// jf. produktbeslutning 2026-08-13 (ikke slått sammen med nærmeste
// navngitte øy, ikke ekskludert).
function beskrivOyer(besokteOyer) {
  const navngitte = besokteOyer.filter((o) => o.navn).map((o) => o.navn);
  const antallNavnlose = besokteOyer.length - navngitte.length;
  const deler = [...navngitte];
  if (antallNavnlose === 1) deler.push('et navnløst skjær');
  else if (antallNavnlose > 1) deler.push(`${antallNavnlose} navnløse skjær`);
  if (deler.length === 0) return '';
  if (deler.length === 1) return deler[0];
  return `${deler.slice(0, -1).join(', ')} og ${deler[deler.length - 1]}`;
}

// Årstid fra funnets EGET tidspunkt (observasjonstidspunktet brukeren
// oppga), ikke opprettet (når raden ble lagret i D1) — semantisk riktig for
// "hvilken årstid ble dette sett", jf. plan-notatet for denne avgjørelsen.
function sesong(tidspunktIso) {
  const m = new Date(tidspunktIso).getUTCMonth(); // 0-11
  if (m === 11 || m === 0 || m === 1) return 'vinter';
  if (m >= 2 && m <= 4) return 'var';
  if (m >= 5 && m <= 7) return 'sommer';
  return 'host';
}

export async function beregnFremdrift(brukerId, env) {
  const { results: funn } = await env.DB.prepare(
    `SELECT art_taxon_id, art_norsk, artstype, rodlistekategori, lat, lon, tidspunkt, opprettet
     FROM funn WHERE registrert_av_bruker_id = ?`
  )
    .bind(brukerId)
    .all();

  const distinkteTaxonIder = [...new Set(funn.filter((f) => f.art_taxon_id != null).map((f) => f.art_taxon_id))];

  // Global MIN(opprettet) per art_taxon_id, kun for artene denne brukeren
  // faktisk har — brukt til "Oppdager"-bonus (var brukerens egen første
  // registrering av arten også den aller første i fellesskapet?).
  let globaltForste = new Map();
  if (distinkteTaxonIder.length > 0) {
    const plassholdere = distinkteTaxonIder.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT art_taxon_id, MIN(opprettet) AS forste FROM funn WHERE art_taxon_id IN (${plassholdere}) GROUP BY art_taxon_id`
    )
      .bind(...distinkteTaxonIder)
      .all();
    globaltForste = new Map(results.map((r) => [r.art_taxon_id, r.forste]));
  }

  // --- registreringer / arter / artstyper ---
  const antallRegistreringer = funn.length;
  const antallArter = distinkteTaxonIder.length;
  const distinkteArtstyper = new Set(funn.map((f) => f.artstype));
  const artstypeTyper = ARTSTYPER.map((t) => ({ artstype: t, dekket: distinkteArtstyper.has(t) }));

  // --- rødliste (én gang per distinkt art, mest alvorlige kategori brukeren har registrert) ---
  const rodlisteRekkefolge = { NT: 1, VU: 2, EN: 3, CR: 3 };
  const rodlistePerArt = new Map(); // art_taxon_id -> mest alvorlige kode
  for (const f of funn) {
    if (!f.art_taxon_id || !f.rodlistekategori) continue;
    const gjeldende = rodlistePerArt.get(f.art_taxon_id);
    if (!gjeldende || rodlisteRekkefolge[f.rodlistekategori] > rodlisteRekkefolge[gjeldende]) {
      rodlistePerArt.set(f.art_taxon_id, f.rodlistekategori);
    }
  }
  const rodlisteArter = [...rodlistePerArt.entries()].map(([artTaxonId, kategori]) => ({
    artTaxonId,
    kategori,
    artNorsk: funn.find((f) => f.art_taxon_id === artTaxonId)?.art_norsk ?? null,
  }));
  const rodlistePoeng = rodlisteArter.reduce((sum, r) => sum + POENG.RODLISTE[r.kategori], 0);

  // Arten som faktisk UTLØSTE Rødlistejeger-merket — den først registrerte
  // (etter opprettet) rødlistede funnet, ikke nødvendigvis den mest
  // alvorlige kategorien brukeren har (det er rodlisteArter sitt formål).
  // Brukt til å gjøre merkebeskrivelsen konkret i stedet for generisk, se
  // produkttilbakemelding 2026-08-13.
  const rodlisteTrigger = funn
    .filter((f) => f.rodlistekategori)
    .sort((a, b) => (a.opprettet < b.opprettet ? -1 : 1))[0] ?? null;

  // --- sjeldenhet (én gang per distinkt art, se toppkommentarene for
  // trappetrinn/terskler/hvorfor "ikke i cachen" = "vanlig") ---
  const frekvensTabell = await hentFrekvensTabell(env);
  const sjeldenhetPerArt = new Map(); // art_taxon_id -> kategori
  for (const taxonId of distinkteTaxonIder) {
    sjeldenhetPerArt.set(taxonId, sjeldenhetKategori(frekvensTabell.get(taxonId)));
  }
  const sjeldenhetPoeng = [...sjeldenhetPerArt.values()].reduce(
    (sum, kategori) => sum + (POENG.SJELDENHET[kategori] || 0),
    0
  );
  // Kun de to badge-relevante trinnene (svært sjelden/sjelden) — "mindre
  // vanlig" gir poeng, men regnes ikke som "sjelden" i UI-teksten, se
  // beskrivSjeldneArter().
  const sjeldneArter = [...sjeldenhetPerArt.entries()]
    .filter(([, kategori]) => kategori === 'svaert_sjelden' || kategori === 'sjelden')
    .map(([artTaxonId, kategori]) => ({
      artTaxonId,
      kategori,
      frekvens: frekvensTabell.get(artTaxonId),
      artNorsk: funn.find((f) => f.art_taxon_id === artTaxonId)?.art_norsk ?? null,
    }));

  // Arten som UTLØSTE Sjeldenhetsjeger-merket — først registrerte funn (etter
  // opprettet) av en art i en badge-relevant kategori, samme mønster som
  // rodlisteTrigger over.
  const sjeldenhetTriggerFunn = funn
    .filter((f) => {
      const k = f.art_taxon_id ? sjeldenhetPerArt.get(f.art_taxon_id) : null;
      return k === 'svaert_sjelden' || k === 'sjelden';
    })
    .sort((a, b) => (a.opprettet < b.opprettet ? -1 : 1))[0] ?? null;
  const sjeldenhetTrigger = sjeldenhetTriggerFunn
    ? { ...sjeldenhetTriggerFunn, kategori: sjeldenhetPerArt.get(sjeldenhetTriggerFunn.art_taxon_id), frekvens: frekvensTabell.get(sjeldenhetTriggerFunn.art_taxon_id) }
    : null;

  // --- oppdager-bonus ---
  const egenForstePerArt = new Map();
  for (const f of funn) {
    if (!f.art_taxon_id) continue;
    const gjeldende = egenForstePerArt.get(f.art_taxon_id);
    if (!gjeldende || f.opprettet < gjeldende) egenForstePerArt.set(f.art_taxon_id, f.opprettet);
  }
  const oppdagetArter = [...egenForstePerArt.entries()]
    .filter(([taxonId, egenForste]) => globaltForste.get(taxonId) === egenForste)
    .map(([artTaxonId]) => ({
      artTaxonId,
      artNorsk: funn.find((f) => f.art_taxon_id === artTaxonId)?.art_norsk ?? null,
    }));

  // --- øyhopper — ekte, navngitte øy-polygoner (lib/oyer.js), erstatter
  // den tidligere 120m-avstandsklyngingen, se konsept.md "Øyhopper —
  // landmasse-definisjon" og plan-notatet 2026-08-13. Funn som ikke treffer
  // noen kjent øy (upresis GPS helt ved en strand, eller åpent hav) telles
  // ikke — se lib/oyer.js sin finnOy()-dokumentasjon for denne avgrensningen.
  const oyPerFunn = funn.map((f) => finnOy(f.lat, f.lon)).filter(Boolean);
  const besokteOyerMap = new Map(oyPerFunn.map((o) => [o.id, o]));
  const besokteOyer = [...besokteOyerMap.values()];
  const antallOyer = besokteOyer.length;

  // --- årstidene rundt ---
  const distinkteSesonger = new Set(funn.map((f) => sesong(f.tidspunkt)));

  const score = {
    registreringer: antallRegistreringer * POENG.REGISTRERING,
    arter: antallArter * POENG.NY_ART,
    artstyper: distinkteArtstyper.size * POENG.NY_ARTSTYPE,
    rodliste: rodlistePoeng,
    sjeldenhet: sjeldenhetPoeng,
    oppdager: oppdagetArter.length * POENG.OPPDAGER,
    oyhopper: Math.max(0, antallOyer - 1) * POENG.OYHOPPER_PER_EKSTRA_KLYNGE,
  };
  const totalt = Object.values(score).reduce((a, b) => a + b, 0);

  const badges = [
    {
      nokkel: 'oppdageren',
      navn: 'Oppdageren',
      beskrivelse: 'Først i fellesskapet til å registrere en gitt art.',
      opptjent: oppdagetArter.length > 0,
    },
    {
      nokkel: 'rodlistejeger',
      navn: 'Rødlistejeger',
      // Var "Første NT/VU/EN/CR-funn." — for teknisk (rå rødliste-koder),
      // produkttilbakemelding 2026-08-13. "Rødlistet" er allerede et kjent
      // begrep i appen (se rodlisteBadge() i funndetaljer), her paret med
      // et vanlig ord i stedet for kodene. Utvidet samme dag til å nevne
      // hvilken art som faktisk utløste merket (rodlisteTrigger over), ikke
      // bare beskrive kriteriet generisk — konkret er mer motiverende enn
      // abstrakt, og brukeren har allerede spurt "hvilken art var det?".
      beskrivelse: rodlisteTrigger
        ? `Første funn av en rødlistet (truet) art — ${rodlisteTrigger.art_norsk}, ${RODLISTE_LABELS[rodlisteTrigger.rodlistekategori]} (${rodlisteTrigger.rodlistekategori}).`
        : 'Første funn av en rødlistet (truet) art.',
      opptjent: rodlisteArter.length > 0,
    },
    {
      nokkel: 'sjeldenhetsjeger',
      navn: 'Sjeldenhetsjeger',
      // Samme "navngi den konkrete arten"-mønster som Rødlistejeger over.
      // Trigges av laveste kvalifiserende trinn (sjelden ELLER svært
      // sjelden) — se konsept.md sin vurdering for hvorfor ikke bare
      // toppnivået: for smalt til å være oppnåelig for et fellesskap på
      // 10-15 brukere.
      beskrivelse: sjeldenhetTrigger
        ? `Første funn av en sjelden art — ${sjeldenhetTrigger.art_norsk}${sjeldenhetTrigger.kategori === 'svaert_sjelden' ? ' (svært sjelden' : ' (sjelden'}, ${sjeldenhetTrigger.frekvens} observasjon${sjeldenhetTrigger.frekvens === 1 ? '' : 'er'} lokalt).`
        : 'Første funn av en sjelden eller svært sjelden art.',
      opptjent: sjeldneArter.length > 0,
    },
    ...ARTSSAMLER_TERSKLER.map((mal, i) => ({
      nokkel: `artssamler_${i + 1}`,
      navn: ARTSSAMLER_NAVN[i],
      beskrivelse: `${mal} ulike arter.`,
      opptjent: antallArter >= mal,
      progresjon: { naa: antallArter, mal },
    })),
    {
      nokkel: 'mangfoldsmester',
      navn: 'Mangfoldsmester',
      beskrivelse: 'Minst én art i hver av de 17 artstypene.',
      opptjent: distinkteArtstyper.size === ARTSTYPER.length,
      progresjon: { naa: distinkteArtstyper.size, mal: ARTSTYPER.length },
    },
    {
      nokkel: 'oyhopper_2',
      navn: 'Øyhopper',
      // Var "Funn på minst 2 adskilte steder." — "steder" byttet til "øyer"
      // og beskrivelsen nevner nå de faktiske øyene (samme mønster som
      // Rødlistejeger, produkttilbakemelding 2026-08-13), siden Øyhopper nå
      // er basert på ekte, navngitte øy-polygoner (lib/oyer.js) i stedet
      // for en anonym avstandsklynge.
      beskrivelse:
        antallOyer >= 2 ? `Funn på minst 2 øyer — ${beskrivOyer(besokteOyer)}.` : 'Funn på minst 2 øyer.',
      opptjent: antallOyer >= 2,
      progresjon: { naa: antallOyer, mal: 2 },
    },
    {
      // Var oyhopper_3/"minst 3 øyer" — hevet til 5 (tilbakemelding
      // 2026-08-14), nøkkelen omdøpt til å matche så den ikke lyver om
      // terskelen for en fremtidig leser.
      nokkel: 'oyhopper_5',
      navn: 'Øyhopper II',
      beskrivelse:
        antallOyer >= 5 ? `Funn på minst 5 øyer — ${beskrivOyer(besokteOyer)}.` : 'Funn på minst 5 øyer.',
      opptjent: antallOyer >= 5,
      progresjon: { naa: antallOyer, mal: 5 },
    },
    {
      nokkel: 'arstidene_rundt',
      navn: 'Årstidene rundt',
      beskrivelse: 'Registrert i alle fire årstider.',
      opptjent: distinkteSesonger.size === 4,
      progresjon: { naa: distinkteSesonger.size, mal: 4 },
    },
  ];

  return {
    score: {
      totalt,
      elementer: [
        { nokkel: 'registreringer', etikett: 'Registreringer', poeng: score.registreringer, detalj: `${antallRegistreringer} registreringer` },
        { nokkel: 'arter', etikett: 'Ulike arter', poeng: score.arter, detalj: `${antallArter} arter` },
        { nokkel: 'artstyper', etikett: 'Artstype-dekning', poeng: score.artstyper, detalj: `${distinkteArtstyper.size} av ${ARTSTYPER.length} artstyper` },
        { nokkel: 'rodliste', etikett: 'Rødlistede arter', poeng: score.rodliste, detalj: `${rodlisteArter.length} rødlistede arter` },
        {
          nokkel: 'sjeldenhet',
          etikett: 'Sjeldne arter',
          poeng: score.sjeldenhet,
          detalj: beskrivSjeldneArter(sjeldneArter),
          // Alltid synlig kilde-disclosure, IKKE bak en tooltip — se
          // konsept.md sin vurdering for hvorfor. Vist av klienten rett
          // under denne raden (renderFremdrift() i js/app.js), ikke bare
          // logget/dokumentert — brukeren skal se forbeholdet FØR de undrer
          // seg over hvorfor et funn de trodde var sjeldent ga 0p.
          kildeDisclosure:
            'Sjeldenhet er beregnet fra en kuratert liste over kjente observasjoner nær Bondøya (289 arter, oppdatert ukentlig) — ikke en fullstendig oversikt over hva som faktisk finnes.',
        },
        { nokkel: 'oppdager', etikett: 'Oppdager-bonus', poeng: score.oppdager, detalj: `${oppdagetArter.length} arter registrert først i fellesskapet` },
        { nokkel: 'oyhopper', etikett: 'Øyhopper', poeng: score.oyhopper, detalj: `funn registrert på ${antallOyer} øyer` },
      ],
    },
    // Rått tall i tillegg til score.elementer sin tekstlige "detalj" —
    // brukt av admin-oversikten (routes/admin.js sin hentAdminFremdrift())
    // for å slippe å parse et menneskelesbart strengfelt for å få tallet ut.
    antallArter,
    artstypeDekning: { totalt: ARTSTYPER.length, dekket: distinkteArtstyper.size, typer: artstypeTyper },
    rodliste: { arter: rodlisteArter },
    sjeldenhet: { arter: sjeldneArter },
    oppdagetArter,
    oyhopper: { antallOyer, oyer: besokteOyer },
    badges,
  };
}
