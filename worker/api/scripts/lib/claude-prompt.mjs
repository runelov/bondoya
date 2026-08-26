// To prompt-varianter til KI-benchmarket:
//   buildPromptDagens()    — ordrett kopi av buildPrompt() i
//                             worker/ki-proxy/src/index.js. Holdes i sync
//                             for hånd (samme situasjon som ARTSTYPER-listen
//                             i js/app.js, se CLAUDE.md "Species-type
//                             taxonomy") — endres ki-proxyens prompt, må
//                             denne oppdateres til å matche før "kontroll"
//                             fortsatt er en ærlig kontroll.
//   buildPromptForbedret()  — samme prompt PLUSS tre isolerte tillegg, for å
//                             kunne måle hver for seg i skåringen:
//                             (1) sesongkontekst utledet fra funnets
//                                 tidspunkt (fenologi),
//                             (2) en kort instruks om kjente vanskelige
//                                 lokale artsgrupper (måker, plantetrekk),
//                             (3) KVALITATIV i stedet for RÅ TALLFRAMING av
//                                 lokal plausibilitet — lagt til 2026-08-21
//                                 etter benchmark-funn: rå tall ("observert
//                                 287 ganger") ga et par konkrete
//                                 feilklassifiseringer der KI byttet fra et
//                                 riktig svar (uten dette tallet i prompten)
//                                 til en lokalt tallrik, men feil, kandidat
//                                 (se rådyr→hjort- og
//                                 engsoleie→tiriltunge-eksemplene i
//                                 benchmark-rapporten) — mistanke om at et
//                                 stort, spesifikt tall leses som sterkere
//                                 bevis enn det faktisk er. Bøtter
//                                 (sjelden/vanlig/svært vanlig) beholder
//                                 samme stedsforankrede signal uten den
//                                 skarpe "N observasjoner = fasit"-følelsen.
//                             Selve kandidatlisten (kandidater-parameteren)
//                             er IKKE en del av denne fila — den kommer fra
//                             kandidatliste-dagens.json/-forbedret.json
//                             (se bygg-kandidatlister.mjs).

function byggKandidatTekstRaaTall(kandidater, maksKandidater) {
  return kandidater.length
    ? kandidater.slice(0, maksKandidater).map(k =>
        `- ${k.norsk} (${k.latinsk}), artstype: ${k.artstype}, ${
          k.plausibilitet > 0 ? `observert ${k.plausibilitet} ganger tidligere nær dette stedet` : 'ikke tidligere observert nær dette stedet, men økologisk mulig'
        }`
      ).join('\n')
    : '(ingen stedsspesifikk kandidatliste tilgjengelig)';
}

function plausibilitetBoette(n) {
  if (n <= 0) return 'ikke tidligere observert nær dette stedet, men økologisk mulig';
  if (n < 5) return 'sjelden observert nær dette stedet';
  if (n < 20) return 'observert nær dette stedet';
  return 'vanlig observert nær dette stedet';
}

function byggKandidatTekstKvalitativ(kandidater, maksKandidater) {
  return kandidater.length
    ? kandidater.slice(0, maksKandidater).map(k =>
        `- ${k.norsk} (${k.latinsk}), artstype: ${k.artstype}, ${plausibilitetBoette(k.plausibilitet)}`
      ).join('\n')
    : '(ingen stedsspesifikk kandidatliste tilgjengelig)';
}

function promptMal({ kandidatTekst, ekstraTekst = '' }) {
  return `Du identifiserer arter (fugl, planter, alger, sopp, sjøpattedyr, fisk, bløtdyr, krepsdyr, \
insekt, edderkoppdyr, krypdyr, amfibium, nesledyr, pigghud, leddorm) fra feltbilder tatt på \
Bondøya, en liten værhard kystøy i Ytre Vikna, Trøndelag, Norge. Dette er en homogen \
kystlokalitet — innlandsarter og fjellarter er svært usannsynlige her.

Lokalt kjente/plausible arter (prioriter disse, men si tydelig fra hvis bildet \
åpenbart viser noe annet):
${kandidatTekst}
${ekstraTekst}
Se på bildet og gi 1-3 kandidater, sortert med mest sannsynlige først. Vær ærlig \
om usikkerhet — ikke tving frem en lokal art hvis bildet klart viser noe annet.

For HVER kandidat: skriv ett kort setning (maks ca. 20 ord, på norsk) i "saertrekk" \
om hva du konkret ser i DETTE bildet som peker mot akkurat denne arten — og som \
skiller den fra de andre kandidatene du foreslår (f.eks. nebbform, fargetegning, \
vokseform, størrelsesforhold). Dette vises direkte til brukeren for å hjelpe dem \
velge riktig når du er usikker, så vær konkret og bildespesifikk, ikke en generisk \
artsbeskrivelse.

Svar KUN med gyldig JSON i nøyaktig dette formatet, ingen annen tekst, ingen \
markdown-kodeblokk:
{"kandidater":[{"norsk":"...","latinsk":"...","artstype":"fugl|pattedyr|sjøpattedyr|plante|alge|sopp|fisk|bløtdyr|krepsdyr|insekt|edderkoppdyr|krypdyr|amfibium|nesledyr|pigghud|leddorm|annet","konfidens":0.0,"saertrekk":"..."}]}`;
}

// maksKandidater=20 er ordrett dagens produksjonsgrense (se
// worker/ki-proxy/src/index.js) — IKKE endre denne uten å endre der også,
// "kontroll" i benchmarket slutter da å være en ærlig kontroll.
export function buildPromptDagens(kandidater, maksKandidater = 20) {
  return promptMal({ kandidatTekst: byggKandidatTekstRaaTall(kandidater, maksKandidater) });
}

const SESONG_TEKST = {
  vinter: 'Det er vinter (des–feb) — de fleste trekkfugler og blomstrende planter er ikke til stede; tenk overvintrende arter, bar/vissen vegetasjon, eventuelt snø/is i bildet.',
  var: 'Det er vår (mar–mai) — trekkfugler ankommer, hekkedrakt hos fugl, tidlige vårplanter i blomst.',
  sommer: 'Det er sommer (jun–aug) — hovedsesong for blomstrende planter og de fleste virvelløse dyr, hekkesesong for fugl.',
  host: 'Det er høst (sep–nov) — høsttrekk hos fugl, mange planter i frukt/frø fremfor blomst, sopp-sesong.',
};

function utledSesong(tidspunktIso) {
  if (!tidspunktIso) return null;
  const maaned = new Date(tidspunktIso).getUTCMonth() + 1; // 1-12
  if ([12, 1, 2].includes(maaned)) return 'vinter';
  if ([3, 4, 5].includes(maaned)) return 'var';
  if ([6, 7, 8].includes(maaned)) return 'sommer';
  return 'host';
}

const VANSKELIGE_GRUPPER_TEKST = `
Vær spesielt oppmerksom på disse kjente forvekslingsfeltene:
- Måkearter (gråmåke/fiskemåke/sildemåke/svartbak/krykkje) ligner hverandre sterkt — \
legg vekt på nebbfarge/-flekk, beinfarge, vingespissmønster og kroppsstørrelse relativt \
til andre objekter i bildet, ikke bare generell "måkefarge".
- Hjortedyr (elg/rådyr/hjort) skiller seg tydelig i kroppsstørrelse og proporsjoner —
rådyr er lite og spinkelt, elg er svært stort med hengende mule, hjort er mellomstort med
tydelig lysere "speil" bak. Ikke anta den lokalt mest observerte arten uten å faktisk vurdere
størrelse/proporsjoner i bildet.
- For planter: vokseform (opprett/krypende/tuedannende), bladform og -kant, og eventuell \
blomst/frøstand er langt mer diagnostisk enn fargen alene — mange kystplanter her er \
grønne/grå i store deler av sesongen.

Kandidatlisten under viser lokal plausibilitet som en grov, kvalitativ vurdering (sjelden/
observert/vanlig), IKKE en fasit — en art merket "vanlig observert" er ikke automatisk riktig
svar; vurder alltid det du faktisk ser i bildet først, og bruk plausibiliteten kun til å
avgjøre mellom ellers like sannsynlige kandidater.`;

// maksKandidater=50 — fjerde, isolert endring fra dagens 20: en
// kandidatliste balansert på tvers av artstyper (se bygg-kandidatlister.mjs)
// blir fort lengre enn 20 før "plante" (61 % av alle funn) får rimelig
// dekning, og selve listeteksten koster nesten ingenting i kontekstlengde
// sammenlignet med bildet — helt ulikt max_tokens på selve SVARET (1024),
// som er det som faktisk koster.
export function buildPromptForbedret(kandidater, tidspunktIso, maksKandidater = 50) {
  const sesong = utledSesong(tidspunktIso);
  const sesongTekst = sesong ? `\n${SESONG_TEKST[sesong]}\n` : '';
  return promptMal({
    kandidatTekst: byggKandidatTekstKvalitativ(kandidater, maksKandidater),
    ekstraTekst: `${sesongTekst}${VANSKELIGE_GRUPPER_TEKST}\n`,
  });
}
