// Fint lag i Worker+KV, se konsept.md "Sikring av innloggingssiden". Merk:
// Workers KV er eventually consistent (skriving kan ta opptil ~60 sek å nå
// alle edge-noder) — to raske forespørsler mot ulike POP-er kan i teorien
// begge lese en gammel telling og begge slippe gjennom. Akseptabel
// restrisiko her: Turnstile + Cloudflares native IP-regel er andre lag
// foran dette, og selve token-entropien (ikke rate-limiting) er
// hovedforsvaret på verifiseringssteget. Ikke en garanti, bare friksjon.

const TIME_WINDOW_SEC = 3600; // 1 time

// Maks 3 lenke-forespørsler/e-post/time, min. 60 sek mellom hver.
export async function sjekkOgTellEpost(epost, env) {
  const key = `rl:epost:${epost.toLowerCase()}`;
  const now = Date.now();
  const data = await lesTelling(env, key);

  if (now - data.sisteForsok < 60_000) return false;
  if (data.antall >= 3) return false;

  await env.RATE_LIMIT.put(
    key,
    JSON.stringify({ antall: data.antall + 1, sisteForsok: now }),
    { expirationTtl: TIME_WINDOW_SEC }
  );
  return true;
}

// Generisk per-IP-teller — maks varierer per endepunkt (5-10/time på
// lenke-forespørsel, løsere ~20/time på selve verifiseringen).
export async function sjekkOgTellIp(ip, formal, maks, env) {
  const key = `rl:ip:${formal}:${ip}`;
  const data = await lesTelling(env, key);

  if (data.antall >= maks) return false;

  await env.RATE_LIMIT.put(
    key,
    JSON.stringify({ antall: data.antall + 1, sisteForsok: Date.now() }),
    { expirationTtl: TIME_WINDOW_SEC }
  );
  return true;
}

async function lesTelling(env, key) {
  const raw = await env.RATE_LIMIT.get(key);
  return raw ? JSON.parse(raw) : { antall: 0, sisteForsok: 0 };
}
