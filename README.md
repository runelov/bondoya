# Mitt Bondøya (app)

Dette er den **offentlige** delen av Mitt Bondøya: rene statiske filer
(HTML/CSS/JS), ingen personlig innhold. Registrerte funn og bilder hentes fra
et **privat** data-repo — se [mittbondoya-db](https://github.com/runelov/mittbondoya-db).

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
   [mittbondoya-db](https://github.com/runelov/mittbondoya-db).
3. Deploy KI-proxyen — se `worker/ki-proxy/README.md` (krever egen
   Cloudflare- og Anthropic-konto/nøkkel).
4. Skaff et Mapbox access token (gratis tier) for satellittlaget, lagre det i
   nettleserens konsoll: `localStorage.setItem('mittbondoya-mapbox-token', '...')`
   (midlertidig løsning for MVP — flyttes inn i settings-panelet senere).
5. Åpne den publiserte siden → ⚙️-knappen → fyll inn data-repo + token +
   KI-proxy URL → **Koble til**.

## Sikkerhet

- Tokenet (til data-repoet) lagres kun i `localStorage` i nettleseren din —
  aldri i kode eller i dette repoet.
- Alt brukerinnhold escapes før det vises, for å hindre lagret XSS.
- Hold data-repoet **privat** — denne appens Pages-URL er offentlig
  tilgjengelig for alle med lenken, men uten token kan ingen lese eller
  skrive funn.
- `worker/ki-proxy/`s kildekode er trygg å dele — selve AI-nøkkelen settes
  kun som en Cloudflare Worker-hemmelighet, aldri i denne koden.
