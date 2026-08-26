#!/usr/bin/env node
// Siste diagnostisk test i pattedyr-sporet (se benchmark-rapporten
// 2026-08-21): to runder med å justere HVA/HVORDAN lokale kandidater
// tilbys (bredere utvalg, kvalitativ i stedet for rå tallframing,
// eksplisitt elg/rådyr/hjort-skille) endret ingenting — "hjort" ble
// fortsatt valgt feilaktig på alle 4 rådyr-bildene. Spørsmålet nå: er selve
// MEKANISMEN "tilby navngitte lokale alternativer" problemet, uavhengig av
// hvilke arter og hvordan de er ordlagt?
//
// Tester derfor en TREDJE variant på KUN pattedyr-bildene (6 stk, billig):
// dagens promptstruktur (buildPromptDagens), men med en TOM kandidatliste
// — altså "ikke tidligere observert nær dette stedet, men økologisk mulig"
// for alt, ingen navngitte alternativer i det hele tatt. Ren isolasjon av
// mekanismen fra innholdet.
//
// Krever ANTHROPIC_API_KEY i miljøet (samme varsomhet som
// kjor-claude-benchmark.mjs — nøkkelen lagres aldri).
//
// Bruk:
//   cd worker/api
//   ANTHROPIC_API_KEY=sk-... node scripts/test-ingen-kandidater-pattedyr.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptDagens } from './lib/claude-prompt.mjs';
import { kallClaude, sleep } from './lib/claude-api.mjs';

const HER = dirname(fileURLToPath(import.meta.url));
const UTMAPPE = join(HER, 'benchmark');
const RESULTAT_FIL = join(UTMAPPE, 'resultater-ingen-kandidater.json');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Mangler ANTHROPIC_API_KEY i miljøet.');
  process.exit(1);
}

function normaliser(s) { return (s || '').toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim(); }

async function main() {
  const gullsett = JSON.parse(readFileSync(join(UTMAPPE, 'gullsett.json'), 'utf8'));
  const pattedyr = gullsett.filter(f => f.artstype === 'pattedyr');
  console.log(`${pattedyr.length} pattedyr-funn. Kjører med TOM kandidatliste (ingen stedsforankring i det hele tatt).\n`);

  const resultater = existsSync(RESULTAT_FIL) ? JSON.parse(readFileSync(RESULTAT_FIL, 'utf8')) : {};

  for (const funn of pattedyr) {
    if (resultater[funn.id] && !resultater[funn.id].feil) {
      console.log(`  #${funn.id}: allerede gjort, hopper over.`);
      continue;
    }
    const bildeSti = join(UTMAPPE, funn.bildeFil);
    const bildeBase64 = readFileSync(bildeSti).toString('base64');
    const prompt = buildPromptDagens([]); // tom kandidatliste — samme struktur, null stedsforankring

    try {
      const svar = await kallClaude(prompt, bildeBase64, 'image/jpeg');
      resultater[funn.id] = { funnId: funn.id, kandidater: svar, feil: null };
      const topp = svar[0];
      const riktig = topp && normaliser(topp.latinsk) === normaliser(funn.artLatinsk);
      console.log(`  #${funn.id} [fasit: ${funn.artNorsk}] → ${topp ? topp.norsk : '(tomt)'} ${riktig ? '✓' : '✗'}`);
    } catch (e) {
      resultater[funn.id] = { funnId: funn.id, kandidater: [], feil: e.message };
      console.log(`  #${funn.id} → FEIL: ${e.message}`);
    }
    writeFileSync(RESULTAT_FIL, JSON.stringify(resultater, null, 2));
    await sleep(300);
  }

  console.log('\n=== Sammenligning: dagens (17 kuraterte kandidater) vs. ingen kandidater vs. forbedret (balansert liste) ===');
  const gamleResultater = JSON.parse(readFileSync(join(UTMAPPE, 'resultater.json'), 'utf8'));
  let dRiktig = 0, iRiktig = 0, fRiktig = 0, n = 0;
  for (const funn of pattedyr) {
    const d = gamleResultater[`${funn.id}:dagens`];
    const f = gamleResultater[`${funn.id}:forbedret`];
    const i = resultater[funn.id];
    if (!d || !f || !i || d.feil || f.feil || i.feil) continue;
    n++;
    const fasit = normaliser(funn.artLatinsk);
    const dOk = d.kandidater[0] && normaliser(d.kandidater[0].latinsk) === fasit;
    const fOk = f.kandidater[0] && normaliser(f.kandidater[0].latinsk) === fasit;
    const iOk = i.kandidater[0] && normaliser(i.kandidater[0].latinsk) === fasit;
    if (dOk) dRiktig++; if (fOk) fRiktig++; if (iOk) iRiktig++;
    console.log(`  #${funn.id} fasit=${funn.artNorsk.padEnd(10)} dagens(17 kand.)=${dOk ? '✓' : '✗'} ingen_kand.=${iOk ? '✓' : '✗'} (${i.kandidater[0]?.norsk || '-'}) forbedret(64 kand.)=${fOk ? '✓' : '✗'}`);
  }
  console.log(`\nTopp-1: dagens(17 kandidater)=${dRiktig}/${n}, ingen kandidater=${iRiktig}/${n}, forbedret(64 kandidater)=${fRiktig}/${n}`);
}

main();
