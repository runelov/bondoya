# Endringslogg

## 0.9.0 — Fem gjenstående fase 3-punkter før v1
Lukker gapet mellom konsept.md sin fase 3-liste og faktisk kode, avdekket
ved en gjennomgang etter at v0.8.2 sin fulle app-wide sikkerhetsreview var
fullført (se plan `async-sleeping-dragon.md`):

- **Ordentlig artssøk**: fritekst-fallbacken ("bruk som ny art") er fjernet.
  Nytt sesjonsbeskyttet endepunkt `GET /arter/sok` proxy-er live mot
  Artsdatabankens offentlige taxon-API (samme vert `fetch_artskart.py`
  bruker) i stedet for en ny ETL-seed-jobb — alltid ferskt, ingen ny
  D1-tabell. Egen relevanssortering (eksakt treff først) kompenserer for at
  API-et selv kutter av ved 15 treff uten `take`-parameteret.
- **Gruppering/sortering/filtrering av funnlister**: nye rader i
  funnlistepanelet — sorter (nyeste/eldste/alfabetisk/flest funn, pluss
  KI-konfidens for admin), grupper (ingen/art/artstype/måned/bruker). "Kun
  usikre KI-gjenkjenninger"-filter og KI-konfidens-sortering er admin-only.
- **⚙️-panelet er nå admin-only** — var tidligere synlig for alle innloggede,
  i strid med den opprinnelige planen om at det gamle MVP-innstillingspanelet
  (GitHub-token, KI-proxy) skulle flyttes til admin-laget.
- **Kartlagsvelgeren skjules for offentlige besøkende** — de har uansett kun
  ett kartlag (Kartverket), så en velger med ett valg var bare støy.
- **KI-beskjæring + fototips**: nytt steg i registreringsflyten der man kan
  dra en beskjæringsboks over bildet før KI-analyse (hjelper KI når bakgrunn
  ellers dominerer) — det ubeskårne bildet lagres alltid på funnet uansett.
  Statisk fototips-tekst vises når KI er usikker/ikke finner noe.

## 0.8.1 — Sikkerhetsfiks: e-post bundet til invitasjonslenke
`/security-review` av v0.4.2–v0.8.0 avdekket at invitasjonsregistrering
(`POST /invitasjon/:token`) tidligere lot den som klikket lenken oppgi en
**vilkårlig e-postadresse selv**, uten noen verifikasjon av eierskap.
Ulikt den vanlige innloggingsflyten (som først bekrefter e-post ved å sende
en lenke DIT) beviste invitasjonstokenet kun at man hadde fått delt en
lenke — ikke hvilken adresse man faktisk rår over. Konkret risiko: noen med
lenken kunne registrere seg med en annens reelle e-postadresse, kapre den
permanent (`UNIQUE`-constraint på `brukere.epost`) og få en innlogget
sesjon knyttet til den, uten at eieren noensinne fikk noe å bekrefte.

Fikset ved å binde hver invitasjonslenke til én bestemt e-post **admin selv
oppgir ved generering** (ny `epost`-kolonne, migrasjon 0009) — samme
tillitsnivå som at admin allerede vet hvem de inviterer manuelt i dag.
Registrering bruker alltid denne bundne adressen server-side; en eventuell
e-post i registreringsforespørselen ignoreres fullstendig. Eldre
invitasjoner (fra før fiksen, uten bundet e-post) blir permanent
ikke-innløsbare — riktig oppførsel, ikke en feil. Ingen ekstra e-postrunde
for den som registrerer seg — samme sømløse "logg rett inn"-flyt som før.

Fikset også en pre-eksisterende UI-bug fra v0.6.0 oppdaget under
verifisering: "ny lenke"-boksen i adminpanelet ble skjult igjen umiddelbart
etter at den ble vist, slik at admin i praksis aldri fikk sett/kopiert
lenken.

## 0.8.0 — Admin-dashboard
Siste punkt i fase 3-listen: et enkelt bruksstatistikk-dashboard for admin,
åpnet via en ny "📊 Dashboard"-knapp øverst i adminpanelet. Nytt endepunkt
`GET /admin/dashboard` aggregerer eksisterende D1-data (ingen ny migrasjon):
brukere (totalt/aktive/deaktiverte/admin), funn (totalt/denne måneden/
offentlig synlig/per artstype/topp 5 bidragsytere), sider
(totalt/publisert/kladd), invitasjoner (totalt/brukt/ubrukt-gyldig/utløpt),
og antall skjulte arter. Vises som enkle stat-kort (`.statGrid`/`.statCard`
i `css/styles.css`), ingen graf-bibliotek — kun tellinger, ikke tidsserier.

Kostnadsbilde per tjeneste (Cloudflare/Mapbox/Anthropic), nevnt som "hvis
mulig" i konsept.md, er bevisst utelatt denne runden — avklart med
produkteier, ville krevd egne faktureringsAPI-hemmeligheter og en egen
sikkerhetsvurdering.

## 0.7.0 — Artssynlighet admin-override
Admin kan nå skjule/vise arter fra det offentlige laget selv, uten kodeendring
eller deploy — flytter "Arter & synlighet" (konsept.md) fra en hardkodet
`Set` i `worker/api/src/lib/artsvisibility.js` til en ny D1-tabell
`skjulte_arter` (migrasjon 0008, seedet med de samme 7 rødlistede artene som
før — uendret oppførsel ved lansering). Nye endepunkter
`GET/POST/DELETE /admin/skjulte-arter(/:taxonId)`.

**Retroaktiv, ikke bare fremtidig**: å skjule eller vise en art igjen
oppdaterer nå umiddelbart `synlig_for_public` på ALLE eksisterende funn av
den arten, ikke bare funn registrert etter endringen — uten dette ville
"skjul multer pga. sensitiv lokalitet" ikke faktisk beskyttet allerede
registrerte multer-funn, stikk i strid med hensikten. `erSynligForPublic()`
er nå et D1-oppslag (`async`) i stedet for en synkron `Set.has()`-sjekk;
fail-closed-prinsippet for manglende taxonId (Milestone D-sikkerhetsfikset)
er uendret.

## 0.6.0 — Invitasjonslenker
Siste manuelle brukeradministrasjons-steget fra fase 3 er borte: admin kan
nå generere en invitasjonslenke fra adminpanelet i stedet for å legge til
nye brukere via `wrangler d1 execute`. Ny D1-tabell `invitasjoner`
(migrasjon 0007, samme mønster som `innloggingstokens`/`sesjoner` — kun
hash lagres, atomisk engangsbruk via `UPDATE ... RETURNING`, 7 dagers
utløp). Nye endepunkter: `GET/POST /invitasjon/:token` (offentlig, ingen
Turnstile — tokenets 256-bit entropi er selve anti-bot-sperren, kun et
moderat per-IP rate-limit som friksjonslag) og
`GET/POST/DELETE /admin/invitasjoner(/:id)`.

Personen som registrerer seg (kortnavn + e-post) via lenken logges rett inn
med en gang — ingen ekstra e-postrunde, siden selve lenken allerede beviser
at de er invitert. Invitasjoner oppretter alltid vanlig `bruker`-rolle,
aldri admin (det forblir en sjelden, manuell D1-operasjon). Lenken
(`bondoya.no/?inviter=<token>`) leses fra URL-en ved oppstart og fjernes
igjen med `history.replaceState` uansett utfall.

## 0.5.0 — Generisk sidesystem + personvernside
Fase 3 sitt "generiske sidesystem" (konsept.md linje 194-197): admin kan nå
selv opprette/redigere/slette et vilkårlig antall redaksjonelle sider fra
adminpanelet, hver med egen synlighet (offentlig/kun innloggede) og status
(kladd/publisert). Ny D1-tabell `sider` (migrasjon 0006), nye endepunkter
`GET /sider` + `GET /sider/:slug` (offentlig, myk sesjonssjekk — filtrerer
på synlighet+status server-side, 404 for skjulte/kladd-sider fremfor 401 for
å ikke avsløre at de finnes), og `GET/POST/PATCH/DELETE /admin/sider(/:id)`.
Sideinnhold lagres og vises som ren tekst (aldri HTML/markdown) — unngår
XSS-risiko helt, samme `escapeHtml()`-mønster som resten av appen.

Migrasjonen seeder én side, `/personvern` (offentlig, publisert): et
førsteutkast som forklarer hva appen lagrer av personopplysninger (kortnavn
+ e-post), at e-post kun er admin-synlig, at bilder sendt til automatisk
artsgjenkjenning går til Anthropics Claude, at Mapbox/Resend også behandler
data i sine respektive roller, og hvordan man ber om sletting — skyldig
siden Milestone A begynte å lagre ekte personopplysninger. Teksten er
admin-redigerbar uten ny deploy, altså et startpunkt, ikke et bindende
sluttdokument.

Sidene nås via en ny "Sider"-lenkeliste nederst i kontopanelet (synlig
uansett innloggingsstatus, listen filtreres av API-et) — ingen ny
topBar-knapp.

## 0.4.2 — Admin-bryter: skru av offentlig funnvisning helt
Ny global bryter i adminpanelet: "Offentlig funnvisning". Når PÅ (standard,
uendret oppførsel): funn filtreres alltid som før (rødliste og selvvalgte)
og vises i det offentlige laget. Når AV: funn vises verken i kartet eller
funnlisten for besøkende uten innlogging, funnliste-knappen skjules helt,
og selve API-et nekter å utlevere rådata — `GET /funn/offentlig` returnerer
tomt array og `GET /funn/bilde/:id` for et ellers offentlig-synlig funn
krever nå også sesjon når bryteren er av. Håndhevelsen skjer server-side
(`worker/api/src/lib/innstillinger.js`, ny `innstillinger`-tabell i D1,
migrasjon 0005) — ikke bare ved at frontend lar være å spørre om dataene.
Innloggede brukere (vanlige og admin) påvirkes ikke; de ser alltid alle
funn som før.

## 0.4.1 — Sikkerhetsfiks: fail-closed artssynlighet
`/security-review` av 0.4.0 avdekket at manglende `taxonId` (KI-auto-valgte
og fritekst-registrerte funn — den vanligste registreringsveien i appen)
ble regnet som "trygt å vise offentlig" som standard. I praksis betydde det
at et rødlistet funn (f.eks. Ærfugl) gjenkjent av KI-en, uten at noen gjorde
noe galt, kunne bli synlig i det offentlige laget med ekte GPS-posisjon og
bilde. Rettet til fail-closed: ukjent/manglende `taxonId` skjules nå som
standard i stedet for å vises (`erSynligForPublic()` i
`worker/api/src/lib/artsvisibility.js`). Ingen funn i produksjon var
berørt (bekreftet før fiksen ble deployet).

## 0.4.0 — Fase 3 Milestone D: offentlig lag, Mapbox-proxy, rødliste-filtrering
Siste store arkitekturstykke i fase 3 før den fulle app-brede
sikkerhetsgjennomgangen (v1-releasekravet). Se `konsept.md` "Offentlig lag".

- **Offentlig (ikke-innlogget) lag**: uinnloggede besøkende ser nå en live,
  redusert funnliste og kart (kun Kartverket-laget) i stedet for tom/stale
  data — nytt `GET /funn/offentlig`-endepunkt uten sesjonskrav. "Registrert
  av", KI-konfidens og redigerings-/slettemuligheter er utelatt helt fra
  responsen, ikke bare skjult i UI-en. Registrerings- og
  innstillingsknappene er skjult for uinnlogget bruk.
- **Rødliste-/artssynlighet-filtrering**: nytt `funn.synlig_for_public`-felt
  (servergenerert ut fra artens taxonId ved registrering, aldri
  klientoppgitt) håndheves i selve D1-spørringen — rødlistede arters funn
  (NT/VU/EN, Norsk Rødliste 2021) vises aldri i det offentlige laget.
- **Mapbox-flis-proxy**: satellittlaget hentes nå via en sesjonsbeskyttet
  Worker-rute (`GET /tiles/:z/:x/:y`) med et ekte server-only Mapbox-token,
  i stedet for et klient-synlig token i `localStorage`. Rate-limitert per
  IP og edge-cachet (Cloudflare Cache API) bak sesjonssjekken — forsvar mot
  både en stjålet sesjon og unødvendige Mapbox-kostnader. Satellittlaget
  vises kun for innloggede; offentlige besøkende får kun Kartverket.

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
