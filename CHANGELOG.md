# Endringslogg

## 0.3.0 — Fase 3: innlogging, funn-CRUD, admin-tilgang
Ny arkitektur bygget på Cloudflare Worker (`worker/api/`) + D1 + R2,
erstatter "GitHub som backend" for selve funn-registreringen — se
`konsept.md` for full begrunnelse. Bygget og sikkerhetsgjennomgått
(`/security-review`, ingen funn) i tre milestoner samme dag:

- **Milestone A**: passordløs innlogging (magic-link på e-post), D1-baserte
  sesjoner (ikke JWT — admin-deaktivering slår inn umiddelbart), Turnstile +
  rate-limiting på innloggingssiden.
- **Milestone B**: funn (artsobservasjoner) og bilder flyttet til D1/R2 med
  ekte eierskap — brukere kan nå redigere/slette sine egne funn, "Mine
  funn"/"Alle funn"-veksling i listen.
- **Milestone C (kjerne)**: admin-rolle håndheves server-side. Admin kan
  slette hvilket som helst funn (moderasjon), deaktivere en bruker (dreper
  aktive sesjoner umiddelbart), eller permanent slette en bruker (fjerner
  e-post, beholder kortnavnet på eksisterende funn).

Ikke bygget ennå (bevisst avgrenset omfang): invitasjonslenker (nye
brukere legges fortsatt til manuelt), Mapbox-flis-proxy, offentlig
ikke-innlogget lag, rødliste-filtrering, admin-dashboard.

## 0.2.1 — Omdøpt til Bondøya
Appen (og det tilhørende data-repoet) omdøpt fra "Mitt Bondøya"/`mittbondoya`
til "Bondøya"/`bondoya`, i tråd med det nykjøpte domenet `bondoya.no`.
Berører repo-navn (`bondoya`, `bondoya-db`), `localStorage`/IndexedDB-nøkler,
PWA-manifest, KI-proxy Worker-navnet (`bondoya-ki-proxy`), og all
UI-tekst/dokumentasjon. Tidligere oppføringer under er bevisst **ikke**
skrevet om — de beskriver appen som den faktisk het/var strukturert på det
tidspunktet.

Merk: KI-proxyens nye Worker-navn krever en ny `wrangler deploy` for å tre i
kraft; appens lagrede KI-proxy-URL (⚙️-panelet) må oppdateres manuelt til
den nye URL-en etter deploy.

## 0.2.0 — MVP fullført
Fase 1 (MVP) fra konsept.md ansett som fullført og i reell bruk. Alle
kjernefunksjoner bygget, testet og bekreftet fungerende: kartdrevet
registrering (kamera + kamerarull m/EXIF), KI-gjenkjenning, offline-kø,
delt tilgang, PWA-installasjon, artsdetaljer m/rødlistestatus.

To bevisste forbehold ved denne milepælen:
- KI-motor-valget (Claude vision) ble avgjort via reell felttest (90 % treff
  på hoggorm) i stedet for den opprinnelig planlagte side-om-side-
  sammenligningen mot iNaturalist CV — en pragmatisk, felt-validert
  beslutning, ikke en uavklart tråd.
- Kun produkteier har testet appen så langt — reell flerbrukerbruk (de
  øvrige 9-14 brukerne) gjenstår, og vil informere "kritisk
  arkitekturvurdering"-fasen som allerede er planlagt etterpå.

Neste steg: fase 2 (Artsobservasjoner-push) og fase 3
(offentlig/admin/innlogget-lag, se konsept.md) — begge bevisst utsatt,
ikke en del av v1.0.0 før de er bygget og validert.

## 0.1.5 — Rødlistestatus i artsdetaljer
- Hentet ekte Norsk Rødliste 2021-status per art fra Artskart sitt
  taxon-API, lagt til som `rodlisteNorge`/`synligForPublic`-felt i
  `data/species.json`. Rødlistede arter (Ærfugl VU, Storskarv NT, Teist NT,
  Krykkje EN, Gråmåke VU, Fiskemåke VU, Tjeld NT) vises nå med en tydelig
  advarselsbadge i artsdetaljene. `synligForPublic`-feltet er forberedt for
  fase 3 sin offentlig/pålogget-synlighetsstyring (rødlistede arter skjules
  for offentlige som standard, admin kan skjule flere).

## 0.1.4 — "blomst" → "plante"
- Byttet artstypen "blomst" til en bredere "plante" (dekker lyng, gress,
  mose, trær — ikke bare blomstrende planter). Ingen registrerte funn
  brukte "blomst" ennå, så ingen datamigrering nødvendig.

## 0.1.3 — Ordentlig app-ikon
- Erstattet plassholder-ikonet med et design basert på konsept B
  ("luftfoto-utsnitt") — Bondøyas faktiske kystlinje (hentet fra
  OpenStreetMap-geometri, forenklet med shapely) som en cream-farget
  øy omgitt av mørk sjø.

## 0.1.2 — Fjern utdatert meta-tag-advarsel
- Lagt til standard `<meta name="mobile-web-app-capable">` ved siden av
  den Apple-spesifikke taggen (som alene ga en utdatert-advarsel i
  konsollen). Begge beholdes for best kompatibilitet på tvers av
  iOS/Android.

## 0.1.1 — Robusthet i KI-proxyen
- **Rettet feilnavngitt Cloudflare-hemmelighet**: `wrangler secret put` hadde
  blitt kjørt med selve nøkkelverdien som navn ved en feiltakelse, i stedet
  for `ANTHROPIC_API_KEY`/`APP_SHARED_SECRET` — begge er nå satt riktig.
- **Retry ved forbigående 5xx fra Anthropic**: observert i praksis
  (2026-07-11) at kall til Anthropic av og til får et kort, generisk
  `error code: 502`-svar (gateway-hikke, ikke en reell feil med nøkkel/kall).
  Workeren prøver nå opptil 2 ganger til (kort backoff) før den gir opp og
  returnerer feil til appen.

## 0.1.0 — Første MVP-versjon
Grunnleggende funksjonalitet på plass, basert på konsept.md sin fase 1:

- **App-skall + PWA**: statisk SPA, `manifest.json` + `sw.js` for
  "legg til på hjemskjerm".
- **GitHub som backend** (`js/github-store.js`, portert fra FungiFinder):
  privat data-repo (`mittbondoya-db`), delt fine-grained token som både
  tilgangskontroll og skrivemekanisme, `saveWithRetry` for
  samtidighetshåndtering.
- **Kart** (`js/map.js`): Leaflet, begrenset til Bondøya/Liss-Bondøya/Risøya
  (koordinater geokodet via Nominatim), Mapbox Satellite + Kartverket
  topografisk som lagvalg, startvisning fokusert på Bondøya alene.
- **Registreringsflyt**: kamera (live GPS) eller kamerarull
  (etterregistrering), KI-gjenkjenning via egen Cloudflare Worker-proxy
  (`worker/ki-proxy/`) sikret med delt hemmelighet (`X-App-Secret`),
  manuelt artsvalg med fritekst-fallback for uventede funn, manuell
  posisjonsvelger i kart, offline-kø (IndexedDB) for funn registrert uten
  nett.
- **EXIF-lesing** (`exifr`): posisjon og dato fra kamerarull-bilder,
  alltid brukerjusterbar.
- **Stedsforankret artskunnskap**: `data/species.json` (kuratert
  artsreferanse) + `mittbondoya-db/scripts/fetch_artskart.py` (ekte
  Artskart-observasjoner nær Bondøya) brukes til å vekte KI-forslag og
  sortere manuelt artsvalg mot lokal plausibilitet.
- **Funnliste + kartvisning**: filtrering på artstype, artsdetaljer med
  lenke til Artsdatabanken.

### Kjente feil rettet underveis i 0.1.0
- exifr sitt array-form for å plukke enkelttags kastet en intern feil i
  "lite"-bygget — byttet til full `parse()`.
- Artsvalg ble nullstilt når posisjon ble valgt i kart (lokal
  closure-variabel i stedet for delt tilstand).
- Skriftstørrelse i artssøk-trefflisten var for liten (arvet nettleserens
  standard knapp-skrift).
- KI-proxyen manglet feilhåndtering rundt enkelte steg (bilde-lesing,
  tolkning av Anthropic-respons) som kunne gi en uinformativ 500-feil i
  stedet for en diagnostiserbar en.
- Bilde ble ikke vist i artsdetalj-panelet ved klikk på et tidligere funn.
