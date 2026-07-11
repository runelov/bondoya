# Bondøya (app)

Dette er den **offentlige** delen av Bondøya: rene statiske filer
(HTML/CSS/JS), ingen personlig innhold. Registrerte funn og bilder hentes fra
et **privat** data-repo — se [bondoya-db](https://github.com/runelov/bondoya-db).

Full konseptbeskrivelse og arkitekturvalg: se `konsept.md` i workspace-roten
(ikke en del av dette repoet).

## Struktur

```
index.html              Markup
css/styles.css          All styling
js/github-store.js      Generisk GitHub Contents API-modul (les/skriv i privat data-repo)
js/offline-queue.js     IndexedDB-kø for funn registrert uten nett
js/ki-client.js         Klient mot KI-proxyen (worker/ki-proxy/)
js/map.js               Leaflet-kart, begrenset til Bondøya/Liss-Bondøya/Risøya
js/app.js               Applikasjonslogikk (registrering, liste, artsdetaljer)
data/species.json       Kuratert artsreferanse (ikke personlige data — trygt offentlig)
worker/ki-proxy/        Cloudflare Worker: skjuler AI-nøkkel, gir raskt KI-svar
manifest.json, sw.js    PWA-installerbarhet
```

## Oppsett

1. Publiser dette repoet via **GitHub Pages** (Settings → Pages → Deploy from
   branch `main`, mappe `/root`).
2. Sett opp det private data-repoet — se README i
   [bondoya-db](https://github.com/runelov/bondoya-db).
3. Deploy KI-proxyen — se `worker/ki-proxy/README.md` (krever egen
   Cloudflare- og Anthropic-konto/nøkkel, samt en `APP_SHARED_SECRET` du
   finner opp selv, f.eks. med `openssl rand -hex 32`).
4. Skaff et **Mapbox access token** (gratis tier) for satellittlaget — bruk
   et begrenset offentlig token (`pk.*`) låst til din faktiske GitHub
   Pages-URL i Mapbox sitt dashbord (Account → Tokens → URL restrictions),
   ikke standardtokenet med full tilgang.
5. Åpne den publiserte siden → ⚙️-knappen → fyll inn data-repo + token +
   KI-proxy URL + KI-delt hemmelighet + Mapbox-token → **Koble til**.

## Sikkerhet

- **GitHub-tokenet** (til data-repoet) lagres kun i `localStorage` i
  nettleseren din — aldri i kode eller i dette repoet. Bruk et
  fine-grained token med utløpsdato (f.eks. 90 dager), begrenset til kun
  `bondoya-db`.
- **KI-delt hemmelighet** (`X-App-Secret`) hindrer at andre enn appen kan
  kalle KI-proxyen direkte og bruke opp Anthropic-kredittene dine — CORS
  alene stopper kun nettlesere, ikke curl/script mot en lekket Worker-URL.
- **Mapbox-tokenet** er ment å ligge i klientkode (det er hva `pk.*`-tokens
  er for) — sikkerheten der ligger i URL-restriksjon i Mapbox sitt
  dashbord, ikke i å skjule tokenet.
- Alt brukerinnhold escapes før det vises, for å hindre lagret XSS.
- Hold data-repoet **privat** — denne appens Pages-URL er offentlig
  tilgjengelig for alle med lenken, men uten token kan ingen lese eller
  skrive funn.
- `worker/ki-proxy/`s kildekode er trygg å dele — selve AI-nøkkelen og den
  delte hemmeligheten settes kun som Cloudflare Worker-hemmeligheter,
  aldri i denne koden.
- Vurder å skru på **secret scanning + push protection** (repo Settings →
  Security → Code security) på både dette og `bondoya-db`-repoet, som
  et sikkerhetsnett mot at noen ved et uhell committer en ekte nøkkel.
