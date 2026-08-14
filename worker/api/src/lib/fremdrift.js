import { ARTSTYPER, RODLISTE_LABELS } from './taxonomi.js';
import { finnOy } from './oyer.js';

// Fase A — personlig fremdrift (poeng, badges, artstype-dekning, øyhopper),
// se konsept.md "Gamification: personlig fremdrift, poeng og badges".
// Beregnes on-the-fly ved hver forespørsel (ingen ny poeng-/badge-tabell)
// — eksplisitt v1-beslutning i konsept.md, billig på denne skalaen
// (10-15 brukere, noen hundre funn).
//
// Sjeldenhet er BEVISST utelatt fra poengformelen her: datakildene
// (REFERANSEDATA-cachen / fylkesoppslag) flyttet server-side under Fase C,
// men å veve dem inn i selve poengsummen er ikke et Fase A-leveranse-punkt
// per konsept.md sin "Stegvis innføringsplan" — ikke glemt, bevisst utsatt.

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
  OPPDAGER: 25,
  OYHOPPER_PER_EKSTRA_KLYNGE: 15,
};

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
    oppdagetArter,
    oyhopper: { antallOyer, oyer: besokteOyer },
    badges,
  };
}
