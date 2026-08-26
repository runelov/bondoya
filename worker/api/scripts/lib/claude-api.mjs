// Delt Claude-kall-logikk, brukt av kjor-claude-benchmark.mjs og
// test-ingen-kandidater-pattedyr.mjs — samme retry/parsing som
// worker/ki-proxy/src/index.js (kontroll-korrekt), faktorert ut hit for å
// unngå å duplisere den ved en tredje benchmark-variant.

function parseModelJson(text) {
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch { return null; } }
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function kallClaude(promptTekst, bildeBase64, mediaType, { modell = 'claude-sonnet-5', maxTokens = 1024 } = {}) {
  const body = JSON.stringify({
    model: modell,
    max_tokens: maxTokens,
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
      if (!parsed) throw new Error(`Kunne ikke tolke svaret som JSON (stop_reason=${data.stop_reason}, ${text.length} tegn): ${text}`);
      return parsed.kandidater || [];
    }
    if (res.status >= 500 && forsok < 3) { await sleep(forsok * 500); continue; }
    const feilTekst = await res.text();
    throw new Error(`Claude API-feil (${res.status}): ${feilTekst.slice(0, 300)}`);
  }
}

export { sleep };
