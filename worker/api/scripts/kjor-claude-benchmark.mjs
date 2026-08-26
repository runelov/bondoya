#!/usr/bin/env node
// Kjører gullsettet (scripts/benchmark/gullsett.json) gjennom Claude vision
// TO ganger per bilde — "dagens" prompt+kandidatliste (kontroll, ordrett som
// worker/ki-proxy/src/index.js i produksjon) og "forbedret"
// prompt+kandidatliste (se lib/claude-prompt.mjs og
// bygg-kandidatlister.mjs for hva som faktisk er endret og hvorfor) — for
// å måle om de konkrete, evidensbaserte endringene faktisk løfter
// treffsikkerheten, ikke bare anta det.
//
// Krever ANTHROPIC_API_KEY i miljøet. Nøkkelen sendes KUN direkte til
// api.anthropic.com (samme kall som ki-proxy selv gjør) — skrives aldri til
// disk, aldri til scripts/benchmark/-resultatfilene, aldri logget.
//
// Resultatfil (scripts/benchmark/resultater.json) er resumerbar — kjør
// scriptet på nytt for å plukke opp der det evt. stoppet (feil,
// avbrutt, e.l.); allerede fullførte (id, variant)-par hoppes over.
//
// Bruk:
//   cd worker/api
//   ANTHROPIC_API_KEY=sk-... node scripts/kjor-claude-benchmark.mjs
//   ANTHROPIC_API_KEY=sk-... node scripts/kjor-claude-benchmark.mjs --maks 10   (kun de 10 første, for en rask smoke test)
//   ANTHROPIC_API_KEY=sk-... node scripts/kjor-claude-benchmark.mjs --artstype plante,pattedyr
//     (kun disse artstypene — brukt til å billig verifisere en endring i
//     kandidatliste/prompt-varianten uten å kjøre alle 81 bilder på nytt.
//     Sletter automatisk gamle "forbedret"-resultater for disse funnene
//     først, siden en endret kandidatliste/prompt gjør dem utdaterte —
//     "dagens" (kontroll, uendret) beholdes og hoppes over som normalt.)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptDagens, buildPromptForbedret } from './lib/claude-prompt.mjs';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');
const MODELL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const ARGS = process.argv.slice(2);
const maksIdx = ARGS.indexOf('--maks');
const MAKS_BILDER = maksIdx !== -1 ? parseInt(ARGS[maksIdx + 1], 10) : Infinity;
const artstypeIdx = ARGS.indexOf('--artstype');
const ARTSTYPE_FILTER = artstypeIdx !== -1 ? ARGS[artstypeIdx + 1].split(',').map(s => s.trim()) : null;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Mangler ANTHROPIC_API_KEY i miljøet. Kjør f.eks.:');
  console.error('  ANTHROPIC_API_KEY=sk-... node scripts/kjor-claude-benchmark.mjs');
  process.exit(1);
}

function lastJson(fil, fallback) {
  return existsSync(fil) ? JSON.parse(readFileSync(fil, 'utf8')) : fallback;
}

function lagreResultater(resultater) {
  writeFileSync(join(UTMAPPE, 'resultater.json'), JSON.stringify(resultater, null, 2));
}

function parseModelJson(text) {
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch { return null; } }
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// max_tokens=512 — samme som produksjonen (worker/ki-proxy/src/index.js) —
// viste seg for lavt under første kjøring: 23/52 kall feilet, de fleste med
// et JSON-svar kappet midt i (typisk midt i "saertrekk"-teksten på
// kandidat 1-2), IKKE bare i "forbedret"-varianten med lengre kandidatliste
// — 512 var altså for knapt for dagens produksjonsprompt også når modellen
// velger å gi 2-3 kandidater med fyldig saertrekk. Hevet til 1024 med god
// margin. Verdt å ta med tilbake til selve worker/ki-proxy/src/index.js
// som et separat, uavhengig funn (se benchmark-rapporten) — dette er
// sannsynligvis en reell, stille feilkilde i produksjon også, ikke bare i
// dette skriptet.
const MAX_TOKENS = 1024;

async function kallClaude(promptTekst, bildeBase64, mediaType) {
  const body = JSON.stringify({
    model: MODELL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: bildeBase64 } },
        { type: 'text', text: promptTekst },
      ],
    }],
  });

  for (let forsok = 1; forsok <= 3; forsok++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body,
      });
    } catch (e) {
      if (forsok === 3) throw new Error(`Nettverksfeil: ${e.message}`);
      await sleep(forsok * 500);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const text = (data.content || []).map(b => b.text || '').join('').trim();
      const parsed = parseModelJson(text);
      if (!parsed) {
        // Ta med stop_reason og HELE (ikke-kappede) svarteksten i
        // feilmeldingen denne gangen — nødvendig for å faktisk se om det
        // var max_tokens-kutt eller noe annet (markdown-kodeblokk,
        // refusal, tomt svar) som var rotårsaken.
        throw new Error(`Kunne ikke tolke svaret som JSON (stop_reason=${data.stop_reason}, ${text.length} tegn): ${text}`);
      }
      return parsed.kandidater || [];
    }
    if (res.status >= 500 && forsok < 3) { await sleep(forsok * 500); continue; }
    const feilTekst = await res.text();
    throw new Error(`Claude API-feil (${res.status}): ${feilTekst.slice(0, 300)}`);
  }
}

async function main() {
  const gullsett = lastJson(join(UTMAPPE, 'gullsett.json'), null);
  if (!gullsett) {
    console.error('Fant ikke scripts/benchmark/gullsett.json — kjør eksporter-benchmark-sett.mjs først.');
    process.exit(1);
  }
  const kandidaterDagens = lastJson(join(UTMAPPE, 'kandidatliste-dagens.json'), null);
  const kandidaterForbedret = lastJson(join(UTMAPPE, 'kandidatliste-forbedret.json'), null);
  if (!kandidaterDagens || !kandidaterForbedret) {
    console.error('Fant ikke kandidatlistene — kjør bygg-kandidatlister.mjs først.');
    process.exit(1);
  }

  const resultater = lastJson(join(UTMAPPE, 'resultater.json'), {});

  let utvalg = gullsett;
  if (ARTSTYPE_FILTER) {
    utvalg = gullsett.filter(f => ARTSTYPE_FILTER.includes(f.artstype));
    console.log(`Filtrert til artstype(r): ${ARTSTYPE_FILTER.join(', ')} — ${utvalg.length}/${gullsett.length} funn.`);
    let slettet = 0;
    for (const f of utvalg) {
      const nokkel = `${f.id}:forbedret`;
      if (resultater[nokkel]) { delete resultater[nokkel]; slettet++; }
    }
    if (slettet) {
      console.log(`Slettet ${slettet} utdaterte "forbedret"-resultater for disse funnene (kandidatliste/prompt er endret siden sist).`);
      lagreResultater(resultater);
    }
  }
  utvalg = utvalg.slice(0, MAKS_BILDER);

  console.log(`Kjører ${utvalg.length} bilder × 2 varianter mot modell "${MODELL}".`);
  console.log(`Kandidatlister: dagens=${kandidaterDagens.length} arter, forbedret=${kandidaterForbedret.length} arter.\n`);

  let gjort = 0, hoppetOver = 0, feilet = 0;
  for (const funn of utvalg) {
    const bildeSti = join(UTMAPPE, funn.bildeFil);
    if (!existsSync(bildeSti)) { console.log(`  #${funn.id}: bilde mangler (${funn.bildeFil}) — hopper over.`); continue; }
    const bildeBuf = readFileSync(bildeSti);
    const bildeBase64 = bildeBuf.toString('base64');
    const mediaType = 'image/jpeg';

    for (const [variant, kandidater, promptFn] of [
      ['dagens', kandidaterDagens, (k) => buildPromptDagens(k)],
      ['forbedret', kandidaterForbedret, (k) => buildPromptForbedret(k, funn.tidspunkt)],
    ]) {
      const nokkel = `${funn.id}:${variant}`;
      // VIKTIG: kun ferdige, VELLYKKEDE kall hoppes over ved gjenopptak.
      // En tidligere versjon hoppet over alt som fantes i resultater.json
      // uansett — inkludert feilede kall — som betød at et kall som
      // feilet pga. for lav max_tokens (se MAX_TOKENS-kommentaren over)
      // ble "låst" som permanent feilet og aldri prøvd på nytt selv etter
      // at grensen ble hevet. Feilede kall prøves nå alltid på nytt.
      if (resultater[nokkel] && !resultater[nokkel].feil) { hoppetOver++; continue; }

      try {
        const prompt = promptFn(kandidater);
        const svar = await kallClaude(prompt, bildeBase64, mediaType);
        resultater[nokkel] = { funnId: funn.id, variant, kandidater: svar, feil: null };
        gjort++;
        const topp = svar[0];
        console.log(`  #${funn.id} [${variant}] → ${topp ? `${topp.norsk} (${Math.round((topp.konfidens || 0) * 100)}%)` : '(tomt svar)'}  [fasit: ${funn.artNorsk}]`);
      } catch (e) {
        resultater[nokkel] = { funnId: funn.id, variant, kandidater: [], feil: e.message };
        feilet++;
        console.log(`  #${funn.id} [${variant}] → FEIL: ${e.message}`);
      }
      lagreResultater(resultater); // skriv fortløpende — tåler avbrudd
      await sleep(300); // skånsom mot Anthropic sin rate-limit
    }
  }

  console.log(`\nFerdig. ${gjort} nye kall, ${hoppetOver} allerede gjort fra før, ${feilet} feilet.`);
  console.log('Neste steg: node scripts/skaar-claude-benchmark.mjs');
}

main();
