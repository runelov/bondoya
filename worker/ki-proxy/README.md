# Mitt Bondøya — KI-proxy

Liten Cloudflare Worker som skjuler `ANTHROPIC_API_KEY` og videresender
feltbilder til Claude vision for artsgjenkjenning. Se `konsept.md` i
workspace-roten for hvorfor dette er det ene unntaket fra "alt er GitHub"
-mønsteret (rask respons i felt, 1-3 sek).

## Oppsett (gjøres av deg — krever egen Cloudflare-konto)

```bash
cd worker/ki-proxy
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # lim inn din egen Anthropic API-nøkkel
npx wrangler deploy
```

Etter deploy får du en URL i stil med
`https://mittbondoya-ki-proxy.<din-konto>.workers.dev` — lim denne inn i
appens "Innstillinger"-panel (feltet "KI-proxy URL").

Når appens faktiske GitHub Pages-URL er kjent, sett `ALLOWED_ORIGIN` i
`wrangler.toml` til den (i stedet for `*`) og re-deploy, for å stramme inn
CORS til kun appen selv.

## Test isolert (uten å koble til appen)

```bash
npx wrangler dev
curl -X POST http://localhost:8787 \
  -F "bilde=@/sti/til/testbilde.jpg" \
  -F 'kandidater=[{"norsk":"havørn","latinsk":"Haliaeetus albicilla","artstype":"fugl","plausibilitet":3}]'
```
