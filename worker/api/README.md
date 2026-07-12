# Bondøya — API

Cloudflare Worker (D1 + Workers KV) som erstatter "GitHub som backend" fra
MVP-en. Denne første milestonen dekker kun autentisering (magic-link +
sesjoner) — se `konsept.md` i workspace-roten for full arkitektur- og
sikkerhetsbegrunnelse, og `/Users/runelovnaeseth/.claude/plans/drifting-chasing-teacup.md`
for implementasjonsplanen dette ble bygget etter.

## Oppsett (gjøres av deg — krever egen Cloudflare-konto)

```bash
cd worker/api
npm install
npx wrangler login
npx wrangler d1 migrations apply bondoya --remote
npx wrangler secret put TURNSTILE_SECRET_KEY   # ekte Turnstile-hemmelighet, ikke testnøkkelen i .dev.vars
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

`api.bondoya.no` er ikke koblet til denne workeren i `wrangler.toml` ennå —
den peker i dag til `bondoya-ki-proxy`. Domenebyttet (inkl. å flytte
KI-proxyen til `ki.bondoya.no` først) gjøres som egen, sekvensert operasjon
når denne workeren er verifisert klar. Frem til da nås den kun via sin
`workers.dev`-URL.

## Lokal utvikling og test

```bash
npx wrangler d1 migrations apply bondoya --local
npx wrangler dev
```

`.dev.vars` (gitignored) setter `TURNSTILE_SECRET_KEY` til Turnstiles
offisielle alltid-bestå testnøkkel og `ENVIRONMENT=development` — i
utviklingsmodus (eller når `RESEND_API_KEY` mangler) logger
`src/lib/epost.js` hele magic-link-URL-en til `wrangler dev`-konsollen i
stedet for å faktisk sende e-post, slik at du kan teste hele flyten uten en
ekte innboks:

```bash
curl -i -X POST http://localhost:8787/auth/be-om-lenke \
  -H 'Content-Type: application/json' \
  -d '{"epost":"din@epost.no","turnstileToken":"test-token"}'
# kopier magic-link-URL-en fra wrangler dev-konsollen
curl -i "http://localhost:8787/auth/verifiser?token=<rå-token-fra-url>"
# kopier Set-Cookie-verdien fra responsen
curl -i http://localhost:8787/meg -H "Cookie: bondoya_sesjon=<verdi>"
```

Brukere må finnes i `brukere`-tabellen fra før for å kunne be om en
innloggingslenke — det finnes ingen selvregistrering ennå (kommer med
invitasjonsflyten i en senere milestone). Legg til deg selv lokalt:

```bash
npx wrangler d1 execute bondoya --local --command \
  "INSERT INTO brukere (epost, kortnavn, rolle) VALUES ('din@epost.no', 'Du', 'admin')"
```

**Ikke** committ ekte e-postadresser/navn noe sted i dette (offentlige)
repoet — se `konsept.md` for hvorfor.
