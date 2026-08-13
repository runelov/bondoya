#!/usr/bin/env node
// Henter navngitte øy-/skjærpolygoner fra OpenStreetMap (Overpass API) for
// Bondøya-området, til bruk i Øyhopper-beregningen (lib/oyer.js/lib/fremdrift.js)
// — erstatter den tidligere avstandsklyngingen (120m-terskel) med ekte
// kystlinjegeometri. Se konsept.md "Øyhopper — landmasse-definisjon" for
// bakgrunnen, og plan-notatet fra 2026-08-13 for selve presisjonsundersøkelsen
// (kjørt manuelt mot Overpass før dette scriptet ble skrevet).
//
// Engangs/sjelden-kjørt script — kystlinjer endrer seg ikke, ingen cron.
// Kjør på nytt manuelt kun hvis kartgrensene (MAP_MAX_BOUNDS i js/map.js)
// endres, eller for å friske opp navnedata hvis OSM oppdateres.
//
// Bevisst ÉN sammensatt Overpass-spørring (`out geom;` på hele
// søkeresultatet gir full geometri for både ways og relasjonsmedlemmer i
// samme svar) i stedet for én spørring per øy — et tidligere forsøk med
// 27 separate oppfølgingsspørringer traff Overpass sin offentlige
// instans sin rate-limiting (429/504, til slutt ECONNREFUSED) etter bare
// et titalls kall. Én spørring er både raskere og mer skånsomt mot en
// delt offentlig tjeneste.
//
// Bruk:
//   cd worker/api
//   node scripts/hent-oyer.mjs
//
// Skriver src/data/oyer-bondoya.json — ingen nettverkstilgang fra selve
// Workeren, dataene bygges statisk inn (with { type: 'json' } i lib/oyer.js).

import { writeFile, readFile } from 'node:fs/promises';

// Valgfri lokal cache av det RÅ Overpass-svaret (samme spørring som under),
// brukt hvis satt — unngår et nytt nettverkskall mot en delt offentlig
// instans som allerede har rate-limitet oss under selve
// presisjonsundersøkelsen 2026-08-13. Sett BONDOYA_OYER_CACHE=/path/til/fil
// for å gjenbruke et tidligere hentet svar i stedet for å spørre på nytt.
const CACHE_PATH = process.env.BONDOYA_OYER_CACHE;

// Samme grense som MAP_MAX_BOUNDS i js/map.js (sørvest, nordøst) —
// (sør,vest,nord,øst) for Overpass sin bbox-rekkefølge.
const BBOX = '64.8109,10.6860,64.8264,10.7463';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Verifisert manuelt 2026-08-13: denne relasjonen er en OSM-datafeil, ikke
// en reell 28. øy — den gjenbruker 3 av Risøya (16613603) sine 4
// medlemsveier, men bytter ut Risøyas korte lukkeway (1219301009, 2 pkt)
// med Bondøyas lange kystlinjeway (4201473, 237 pkt) i stedet, som gir en
// meningsløs sammenslått form. Ingen name/ssr:stedsnr-tag heller.
// Ekskludert eksplisitt her i tillegg til (ikke i stedet for)
// navn+ssr:stedsnr-kravet, siden den feilen ellers kunne dukke opp igjen i
// en fremtidig, litt annerledes Overpass-respons.
const EKSKLUDER_RELASJON_ID = 19171881;

async function overpassSpørring(ql) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Node sin standard-UA blir avvist av Overpass (406) — samme klasse
      // problem som ble funnet med python-requests sin standard-UA mot
      // Cloudflare tidligere i denne appens historie. En beskrivende UA
      // løser det.
      'User-Agent': 'Bondoya-ETL/0.1 (personlig prosjekt; kontakt via GitHub)',
    },
    body: `data=${encodeURIComponent(ql)}`,
  });
  if (!res.ok) throw new Error(`Overpass-spørring feilet: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.elements;
}

function punktLik(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

// Kjeder sammen medlemsveiene til en lukket ring ved å matche endepunkter
// (reverserer en vei ved behov) — verifisert manuelt mot Bondøya/Risøya/
// Purkholmen/Vesterholmen sine relasjoner 2026-08-13, alle fire kjeder
// rent uten hull. Kaster hvis en ring ikke lar seg lukke (bedre å feile
// synlig i dette engangsscriptet enn å stille lagre en ødelagt polygon).
function monterRing(veier) {
  const gjenstaende = veier.map((v) => v.slice());
  let ring = gjenstaende.shift();
  while (gjenstaende.length > 0) {
    const siste = ring[ring.length - 1];
    const idx = gjenstaende.findIndex((v) => punktLik(v[0], siste) || punktLik(v[v.length - 1], siste));
    if (idx === -1) throw new Error('Klarte ikke å lukke ring — umatchet vei gjenstår.');
    const [vei] = gjenstaende.splice(idx, 1);
    ring = punktLik(vei[0], siste) ? ring.concat(vei.slice(1)) : ring.concat(vei.slice(0, -1).reverse());
  }
  return ring;
}

// Stokkskjæret (node 12862064719) er kartlagt som ett enkelt punkt i OSM,
// ikke et polygon — ingen kystlinje tegnet for den. I stedet for å
// utelate den helt (funn nær den ville da aldri matche noen øy), lages en
// liten sirkel-tilnærming rundt punktet. 15m radius er en grov gjetning,
// ikke målt — juster hvis reelle funn nær Stokkskjæret viser seg å falle
// utenfor.
function sirkelPolygon(lat, lon, radiusMeter = 15, punkter = 12) {
  const jordradius = 6371000;
  const ring = [];
  for (let i = 0; i <= punkter; i++) {
    const vinkel = (2 * Math.PI * i) / punkter;
    const dLat = (radiusMeter * Math.cos(vinkel)) / jordradius;
    const dLon = (radiusMeter * Math.sin(vinkel)) / (jordradius * Math.cos((lat * Math.PI) / 180));
    ring.push([lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI]);
  }
  return ring;
}

async function main() {
  let elementer;
  if (CACHE_PATH) {
    console.log(`Bruker lokal cache: ${CACHE_PATH}`);
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    elementer = raw.elements;
    // Denne spesifikke cachen ble hentet med en way+relation-spørring uten
    // node-treff — Stokkskjæret (kun kartlagt som ett punkt i OSM, ingen
    // vei/relasjon) mangler derfor. Lagt til manuelt her fra en tidligere,
    // separat live-spørring samme dag (node 12862064719, tags name
    // "Stokkskjæret" + ssr:stedsnr "269973") — ikke oppdiktede koordinater.
    if (!elementer.some((el) => el.type === 'node')) {
      elementer = [
        ...elementer,
        {
          type: 'node',
          id: 12862064719,
          lat: 64.8259007,
          lon: 10.7368213,
          tags: { name: 'Stokkskjæret', place: 'islet', 'ssr:stedsnr': '269973' },
        },
      ];
    }
  } else {
    elementer = await overpassSpørring(`
      [out:json][timeout:60];
      (
        node["place"~"islet|island"](${BBOX});
        way["place"~"islet|island"](${BBOX});
        relation["place"~"islet|island"](${BBOX});
      );
      out geom;
    `);
  }

  const oyer = [];
  for (const el of elementer) {
    const id = `${el.type}/${el.id}`;
    if (el.type === 'relation' && el.id === EKSKLUDER_RELASJON_ID) {
      console.log(`Hopper over ${id} (${el.tags?.name || '(uten navn)'}) — kjent duplikat/datafeil, se scriptets kommentar.`);
      continue;
    }
    const navn = el.tags?.name && el.tags?.['ssr:stedsnr'] ? el.tags.name : null;

    let polygon;
    if (el.type === 'node') {
      polygon = sirkelPolygon(el.lat, el.lon);
    } else if (el.type === 'way') {
      polygon = el.geometry.map((p) => [p.lat, p.lon]);
      if (!punktLik(polygon[0], polygon[polygon.length - 1])) {
        throw new Error(`Vei ${id} er ikke en lukket ring — uventet, undersøk manuelt.`);
      }
    } else if (el.type === 'relation') {
      const ytreVeier = el.members
        .filter((m) => m.role === 'outer')
        .map((m) => m.geometry.map((p) => [p.lat, p.lon]));
      polygon = monterRing(ytreVeier);
    }

    oyer.push({ id, navn, polygon });
    console.log(`${id}\t${navn || '(uten navn)'}\t${polygon.length} punkter`);
  }

  const path = new URL('../src/data/oyer-bondoya.json', import.meta.url);
  await writeFile(path, JSON.stringify(oyer));
  console.log(`\nSkrev ${oyer.length} øyer til ${path.pathname}`);
  console.log(`Navngitte: ${oyer.filter((o) => o.navn).length}, uten navn: ${oyer.filter((o) => !o.navn).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
