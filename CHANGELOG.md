# Endringslogg

## 0.9.14 — Artsomtale for alle arter, ikke bare de 17 kuraterte
Direkte oppfølging av 0.9.13: "kun 17 arter har beskrivelse" var aldri
intensjonen, bare en bieffekt av at `data/species.json` sitt `beskrivelse`-
felt (håndskrevet av utvikleren — bekreftet 2026-07-16 at Artsdatabankens
taxon-API ikke har noe fritekstfelt i det hele tatt) var eneste kilde.

- **Ny `arter_metadata`-tabell** (migrations/0015), nøklet på taxonId — delt
  på tvers av alle funn av samme art, ikke duplisert per funn og ikke lenger
  begrenset til en kuratert liste. De 17 opprinnelige beskrivelsene er
  overført hit som kilde `admin` (fjernet fra `species.json`).
- **Wikipedia som reserveløsning** når ingen admin har skrevet en omtale:
  `worker/api/src/lib/wikipedia.js` slår opp det latinske navnet mot norsk
  Wikipedias summary-API (fungerer overraskende pålitelig som sidetittel —
  verifisert mot gråmåke/taskekrabbe/hoggorm). Rene stubb-artikler (extract
  under 40 tegn — sett i praksis for taskekrabbe) forkastes som "ikke
  funnet" fremfor å vise nær-tomme setninger. Cache-aside: lagres i
  `arter_metadata` ved første oppslag, gjenbrukes deretter.
- **Admin-skrevet tekst er alltid autoritativ** og overskriver en tidligere
  Wikipedia-hentet rad — ny GET `/arter/:taxonId/beskrivelse` (alle
  innloggede) og PATCH `/admin/arter/:taxonId/beskrivelse` (admin), nytt
  "Admin — artsomtale"-panel i appen for å skrive/redigere.
- Funndetaljvisningen henter nå omtalen asynkront ETTER at panelet vises
  (ikke en blokkerende del av åpningen) — en klientside-cache
  (`artsbeskrivelseCache`) unngår gjentatte oppslag for samme art i én
  økt, og en "hvilket funn er faktisk åpent nå"-sjekk luker ut et sent svar
  hvis brukeren rekker å åpne et annet funn i mellomtiden.

**Krever migrasjon på produksjon før deploy**: `cd worker/api && npm run
db:migrate:remote` (migrasjon 0015).

## 0.9.13 — TaxonId ble aldri lagret, sju nye artstyper, artstype-utledning flyttet server-side
Funnet ved gjennomgang av "Annet"-kategoriserte funn 2026-07-16 (se
0.9.10-notatet om kamskjell/taskekrabbe): en dypere sjekk avdekket at
**taxonId aldri har blitt lagret for noe funn**, ikke bare de historiske
"Annet"-tilfellene.

- **Klientbug siden aller første MVP-commit**: `setValgt()` i registrerings-
  flyten kopierte aldri `taxonId` fra søketreff/KI-kandidater over til
  `pendingArt` — bekreftet 2026-07-16 mot produksjons-D1: samtlige 32 funn
  har `art_taxon_id = NULL`, inkludert funn registrert dagen før. Dette
  gjorde 0.9.11 sin Artsdatabanken-lenke virkningsløs for alt utenom de 17
  kuraterte artene. Fikset i `js/app.js` (alle tre stedene `pendingArt`
  settes).
- **Server-bug i samme slengen**: `validerFunnFelter()` satte det lagrede
  `art_taxon_id` til resultatet av `betruaTaxonId()` — en streng
  sikkerhetssjekk ment KUN for rødliste-synlighet (`synlig_for_public`), som
  bare godtar taxonId for de 17 kuraterte artene. Denne innsnevret dermed
  også hva som ble lagret, uavhengig av klientbugen over. `art_taxon_id`
  lagres nå uendret fra klientens (syntaktisk validerte) verdi;
  `betruaTaxonId()` brukes fortsatt — helt uendret — kun til
  synlighetssjekken, se `worker/api/src/lib/funn.js`.
- **Artstype er nå autoritativ server-side, ikke klientoppgitt**: når et funn
  har en taxonId, slår `validerFunnFelter()` opp arten på nytt mot
  Artsdatabanken og setter artstype selv (`hentAutoritativArtstype()` i ny
  `worker/api/src/lib/taxonomi.js`) — samme "aldri stol på klienten"-prinsipp
  som synlig_for_public, nå utvidet til kategorisering. Klientens artstype
  brukes kun som fallback når taxonId mangler (rene KI-gjetninger uten
  søkebekreftelse).
- **Sju nye artstyper**: `insekt`, `edderkoppdyr`, `krypdyr`, `amfibium`,
  `nesledyr`, `pigghud`, `leddorm` — samme hull som fisk/skjell/krepsdyr i
  0.9.10 (havnet i "annet" fordi `utledArtstype()` manglet grener for dem).
  Innsekter og edderkoppdyr nøkler på `Class` (Artsdatabanken splitter dem
  over et dusin ulike `TaxonGroup`), resten på `TaxonGroup` — se
  `worker/api/src/lib/taxonomi.js` for kilde-verifisering per gruppe.
- **`skjell` omdøpt til `bløtdyr`**: dekket allerede hele Mollusca (landsnegl,
  blekksprut — ikke bare skjell). Ingen produksjonsrader hadde `artstype =
  'skjell'`, så ingen dataflytting nødvendig utover migrasjonens UPDATE
  (for sikkerhets skyld mot lokal test-DB).
- `utledArtstype()`/`ARTSTYPER` konsolidert til én delt kilde
  (`worker/api/src/lib/taxonomi.js`) brukt av både søk og lagring — de lå
  tidligere som to hardkodede kopier som kunne gli fra hverandre.
- Nytt review-script (kjøres IKKE automatisk):
  `worker/api/scripts/foresla-taxonid-backfill.mjs` — foreslår taxonId +
  artstype for de 32 eksisterende funnene uten taxonId, til manuell
  gjennomgang rad for rad.

**Krever migrasjon på produksjon før deploy**: `cd worker/api && npm run
db:migrate:remote` (migrasjon 0014, samme ombygningsmønster som 0011/0013).
**Krever også deploy av worker/ki-proxy** (oppdatert artstype-liste i
KI-prompten), ikke bare worker/api og den statiske appen.

## 0.9.12 — Fjernet falsk 401-konsollfeil for besøkende, tydeligere pålogging-CTA, Turnstile-knapp låst til utfordring er løst
Funnet ved funksjonell testing 2026-07-16.

- **`/meg` logget en rød 401-konsollfeil for HVER offentlig besøkende**,
  selv om appen selv håndterte det helt fint — ingen innlogget bruker er en
  normal, forventet tilstand for en statussjekk-rute, ikke en feilsituasjon.
  `/meg` svarer nå alltid 200, med `{loggedIn: false}` for uinnloggede (se
  `worker/api/src/routes/meg.js` og `js/api-client.js`).
- **"Tilkoblet"-pillen forsvant helt for besøkende** i stedet for å invitere
  til pålogging — viser nå "Logg på for artsobservasjoner" når ingen er
  innlogget (`updateSyncPill()` i `js/app.js`).
- **"Send innloggingslenke"-knappen kunne klikkes før Turnstile-utfordringen
  var løst**, og feilet da uansett server-side. Knappen starter nå disabled
  og aktiveres kun via Turnstile sin `data-callback`/`data-expired-callback`
  (`index.html`, `js/app.js`).

**Krever deploy av `worker/api`, ikke bare den statiske appen** — 401-fiksen
har ingen effekt i produksjon før Workeren er redeployet.

## 0.9.11 — Versjonsnummer synlig for alle, Artsdatabanken-lenke på alle funn
Funnet ved funksjonell testing 2026-07-13.

- **Versjonsnummer var kun synlig for admin** (⚙️-panelet er admin-only
  siden v0.9.0) — vanlige innloggede brukere hadde ingen måte å se hvilken
  versjon som kjørte. Vises nå i "Tilkoblet"-pillen øverst
  (`🟢 Tilkoblet · v0.9.11`), synlig for alle innloggede uansett rolle.
- **Artsdatabanken-lenken i detaljvisningen manglet for de fleste funn**:
  lenken ble kun bygget fra den lokalt kuraterte 17-arts-lista
  (`speciesCache`), ikke fra funnet sin egen `taxonId` — så et funn av
  f.eks. torsk eller blåskjell (utenfor den kuraterte lista, men med gyldig
  taxonId fra artssøket) viste ingen lenke i det hele tatt. Bygges nå
  direkte fra `funn.art.taxonId` når den finnes, som dekker praktisk talt
  alle funn — den kuraterte lista er nå kun en reserveløsning.

## 0.9.10 — Nye artstyper: fisk, skjell, krepsdyr
Fullfører den kritiske gjennomgangen av artstyper fra 2026-07-13: kystnært
dyreliv (torsk/hyse, blåskjell, strandkrabbe) havnet tidligere i "annet"
sammen med sopp før v0.9.7. Bekreftet mot Artsdatabanken (`TaxonGroup`):
"Fisker" → fisk, "Bløtdyr" → skjell, "Krepsdyr" → krepsdyr —
`utledArtstype()` i `worker/api/src/routes/arter.js`.

Samme mønster som Sopp-kategorien: nye kartfarger (teal/rosa/rød,
`js/map.js`), lagt til i artstype-dropdownen og admin sitt
redigeringsskjema (`js/app.js`), KI-promptens gyldige kategorier
(`worker/ki-proxy/src/index.js`), og migrasjon
`0013_add_fisk_skjell_krepsdyr_artstype.sql` (samme ombygning av
`funn`-tabellens CHECK-constraint som 0011, samme forsiktighet med
eksplisitt kolonneliste). Verifisert lokalt: skjema/indeks intakt,
testinnsetting med alle tre nye artstyper lykkes, dropdown og kartfarger
viser riktig i nettleser.

**Krever migrasjon på produksjon før deploy**: `cd worker/api && npm run
db:migrate:remote`.

## 0.9.9 — Filterindikator på kartet, kollapsbare grupper, artstype som dropdown
Funnet ved funksjonell testing 2026-07-13 av funnlisten.

- **Synlig markør på kartet når funn er filtrert**: satte du et filter
  (artstype/"Mine funn"/"kun usikre") og navigerte bort/tilbake i kartet,
  var eneste måte å oppdage det på å åpne Registrerte funn. Ny liten
  tappbar pill ("🔍 Fugl" e.l.) rett under topBar, synlig så lenge et
  filter er aktivt — trykk på den for å hoppe rett til listepanelet. Fikset
  også en liten inkonsistens oppdaget underveis: "Kun usikre KI-
  gjenkjenninger" (admin) oppdaterte tidligere kun listen, ikke kartet.
- **Kollapsbare grupper** i Registrerte funn: hver gruppe (art/artstype/
  måned/bruker) er nå en `<details>` — klikk overskriften for å
  åpne/lukke. Husker hvilke grupper du selv har lukket på tvers av
  re-render (bytte av sortering/filter nullstiller ikke valget ditt
  lenger).
- **Artstype-filteret er nå en dropdown** i stedet for en chip-rad som
  krevde horisontal scroll — samme mønster som Sorter/Grupper, alle tre nå
  i én kompakt rad ("Type / Sorter / Grupper"). Løser både plassproblemet
  og skalerer bedre etter hvert som flere artstyper kommer (fisk/skjell
  under vurdering).

## 0.9.8 — Synlige sorter/grupper-etiketter + rullerings-overlapp for sesjon
Funnet ved funksjonell testing 2026-07-13.

- **Sorter/Grupper-dropdownene i funnlisten manglet synlig etikett** — kun
  `aria-label` (usynlig for seende brukere), så det fremgikk ikke hva
  hver dropdown styrte. Lagt til synlige "Sorter"/"Grupper"-tekster over
  hver (`index.html`, `css/styles.css`).
- **Sesjonstoken-rotasjon (v0.9.4) kunne føre til "mistet innlogging"**:
  produkteier rapporterte at det skjedde av og til, spesielt ved lukking/
  gjenåpning av PWA-en på iPhone. Sannsynlig årsak: hvis klienten ikke
  rekker å motta/lagre den nye Set-Cookie-en fra en rotasjon (f.eks. appen
  lagt i bakgrunnen midt i en forespørsel), sto den igjen med et token
  serveren allerede hadde forkastet.
  Fikset med et 5-minutters overlappingsvindu (migrasjon
  `0012_add_sesjon_grace_period.sql`, nye kolonner `forrige_hash`/
  `forrige_utloper` på `sesjoner`): det GAMLE tokenet godtas fortsatt en
  kort stund etter rotasjon, ved siden av det nye. Svekker ikke
  rotasjonens sikkerhetshensikt nevneverdig (én gang i døgnet, maks 5
  minutter). Verifisert lokalt end-to-end: gammelt token virker rett
  etter rotasjon (simulerer en klient som gikk glipp av Set-Cookie), 401
  etter at overlappet er utløpt, og det nyeste tokenet virker gjennom
  hele forløpet.
  **Krever migrasjon på produksjon før deploy**: `cd worker/api && npm run
  db:migrate:remote`.
- Droppet idé om thumbnail av foreslått art i KI-gjenkjenning (Artsdatabanken
  eksponerer ingen bilde-URL via APIet — ville krevd en ny ekstern
  bildekilde for marginal gevinst utover særtrekk-teksten fra v0.9.4).

## 0.9.7 — Artstype i artssøk + ny "Sopp"-kategori
Funnet ved funksjonell testing av artssøket (Admin — arter): søk på
"multer" ga flere urelaterte sopparter tilbake, umulig å skille fra
hverandre uten å åpne hvert enkelt treff.

- **Artstype vises nå under hvert søketreff** (delt mellom Admin — arter
  sitt søk og registreringsflytens artssøk, samme kortmal) — `js/app.js`,
  `css/styles.css`.
- **Ny egen "Sopp"-kategori**: Kingdom Fungi havnet tidligere i "annet"
  sammen med alt ukategoriserbart, som gjorde artstype-visningen lite nyttig
  for nettopp sopp (alle så like ut som "Annet"). Lagt til i
  `utledArtstype()` (`worker/api/src/routes/arter.js`), kartfarge
  (`js/map.js`), filterlisten i funnlisten, admin sitt artstype-redigerings-
  skjema, og KI-promptens gyldige kategorier (`worker/ki-proxy/src/index.js`).
- **Migrasjon `0011_add_sopp_artstype.sql`**: `funn`-tabellens CHECK-
  constraint tillot ikke `artstype='sopp'` — SQLite støtter ikke å endre en
  CHECK direkte, så tabellen bygges om (samme mønster som SQLite selv
  anbefaler). Verifisert lokalt: skjema, indeks og eksisterende rader intakt
  etter migrasjon, og en testrad med `artstype='sopp'` kunne settes inn uten
  feil.
  **Krever migrasjon på produksjon før deploy**: `cd worker/api && npm run
  db:migrate:remote`.
- Ikke løst (ligger hos Artsdatabanken, ikke noe vi kan fikse): søk på
  "multer" gir fortsatt ingen treff — kun "molte" (den offisielle
  navneformen) finner arten. Søket matcher tydeligvis delvis mot latinsk
  navn, ikke fritekst mot norsk populærnavn.

## 0.9.6 — Kartnåler: hover viser stedsinfo, klikk går rett til artspanelet
Før viste klikk på en funn-nål to ting samtidig: Leaflets egen popup (fra
`marker.bindPopup()`) OG det store artspanelet — forvirrende dobbeltvisning.

- **Hover (mus)**: viser nå en liten, ren popup med art/dato — ingen
  "klikk for mer"-hint (avklart i samtale 2026-07-13: kartnåler oppfattes
  som klikkbare uten det, og popupen skal holdes ren).
- **Klikk**: går rett til det store artspanelet, uten å også åpne den lille
  popupen — popupen bygges nå manuelt med `L.popup()` i stedet for
  `marker.bindPopup()`, som internt ville bundet klikk til å åpne den
  uansett.
- **Touch/mobil uendret**: hover finnes ikke på touch, så oppførselen der
  er fortsatt ett trykk → artspanelet direkte, nå bare uten den overflødige
  popupen.

`js/map.js`: `renderFinds()` tar nå `map` som første parameter (trengs for
å åpne/lukke popupen manuelt).

## 0.9.5 — Fiks: unødvendig KV-bruk på cachede kartfliser
Produkteier fikk Cloudflare-varsel om 50% av daglig Workers KV-kvote brukt
etter egen testing (kun 10-12 registrerte funn). Rotårsak funnet i
[tiles.js](worker/api/src/routes/tiles.js): rate-limiten (`sjekkOgTellIp`,
1 KV-lesing + 1 KV-skriving) kjørte FØR cache-sjekken, så hver eneste
kartflis kostet 2 KV-operasjoner uansett om den allerede lå i cachen —
kartpanorering over noen zoom-nivåer genererer fort hundrevis av fliser.
De seks andre KV-brukende endepunktene (innlogging, KI, artssøk,
invitasjoner) er lavvolum og ikke del av problemet.

Fikset ved å bytte rekkefølge: cache sjekkes nå FØR rate-limiten. Et
cache-treff koster Mapbox ingenting uansett, så det er ingen grunn til å
betale en KV-operasjon for det — kun ekte cache-misser bruker nå KV. Med
1-års cache-levetiden fra v0.9.1 bør de aller fleste fliser fra nå av være
KV-frie.

## 0.9.4 — Hardt zoom-tak, KI-særtrekk, periodisk sesjonsrotasjon
Funnet ved videre funksjonell testing 2026-07-13.

- **Zoom-tak er nå en hard grense, ikke myk oppskalering** (`js/map.js`):
  forrige runde brukte `maxNativeZoom` (skalerer opp siste ekte flis i stedet
  for å hente fliser som ikke finnes) — produkteier testet dette og fikk et
  gråtomt kart i praksis i stedet for ønsket oppførsel. Erstattet med samme
  mønster som `minZoom` allerede bruker: `map.setMaxZoom()` per aktivt
  kartlag (18 Kartverket / 15 Mapbox), synkronisert via Leaflets
  `baselayerchange`. Verifisert direkte i nettleser: tvunget `setZoom(23)`
  stopper på 18, zoom inn-knappen får `leaflet-disabled`, kartet fortsetter å
  vise ekte fliser gjennom hele testen.
- **KI-særtrekk for usikre gjenkjenninger** (`worker/ki-proxy/src/index.js`,
  `js/ki-client.js`, `js/app.js`): når KI foreslår flere kandidater, skriver
  den nå også ett kort, bildespesifikt særtrekk per kandidat (f.eks. hva ved
  nebbform/fargetegning i AKKURAT DETTE bildet peker mot arten) — vises
  under hvert kandidatkort for å gjøre det lettere å velge riktig art.
  Berører kun stien for usikre/flere-kandidater, ikke det trygge
  auto-valget.
- **Periodisk sesjonstoken-rotasjon** (`worker/api/src/lib/session.js`,
  `worker/api/src/index.js`, migrasjon `0010_add_sesjon_rullert.sql`):
  sesjonscookien stod tidligere fast i hele 30-dagers levetiden — et lekket
  token ville vært gyldig helt til utløp. Rulleres nå til en ny tokenverdi
  hvert 24. time av bruk (ren rotasjon — samme opprinnelige `utloper`
  beholdes, ingen stille sesjonsforlengelse). Bevisst periodisk og ikke på
  hvert kall: appen sender ofte parallelle forespørsler (f.eks. alle
  funn-thumbnails samtidig), og rullering på hvert kall ville gitt et race
  der to samtidige kall med samme cookie kunne oppheve hverandre. Rulleres
  sentralt i `index.js` sin fetch()-handler, etter at requestens egen
  autentisering allerede har brukt det gamle tokenet ferdig — denne
  forespørselen påvirkes aldri, kun neste. Verifisert lokalt mot en ekte
  D1-sesjon: gammelt token 401-er umiddelbart etter rullering, nytt token
  fungerer og ruller ikke på nytt før 24-timersvinduet passerer igjen, og
  `Max-Age` i den nye cookien reflekterer korrekt gjenværende tid av de 30
  dagene (ikke en ny full periode).
  **Krever migrasjon på både lokal og produksjon før deploy**:
  `npm run db:migrate:local` / `npm run db:migrate:remote` i `worker/api/`.

## 0.9.3 — UI-funn fra funksjonell testing: konto, funnliste, admin
Funnet ved funksjonell testing 2026-07-13 av konto-, liste- og adminflytene.

- **E-post-felt var ustylte**: `.sheet input[...]`-CSS-regelen dekket
  `type="text"/"password"`, men ikke `type="email"` eller `type="number"` —
  innloggings-/invitasjons-e-post og TaxonId-feltet i admin falt tilbake til
  nettleserens default-styling (smått, ingen padding). Lagt til i selektoren,
  pluss `margin-bottom` slik at Turnstile-widgeten ikke lenger klistrer seg
  til e-post-feltet.
- **Admin-panelets fem seksjoner** (innstillinger/arter/sider/invitasjoner/
  brukere) hadde ingen visuell atskillelse — `.sheet h2` manglet topp-margin,
  så f.eks. "Generer invitasjonslenke"-knappen satt tett inntil
  "Admin — brukere"-overskriften. Lagt til topp-linje + luft foran hver
  overskrift (unntatt den første i panelet).
- **KI-konfidens vises nå i funnlisten** for admin (samme badge-stil som i
  registreringsflyten) — dataen fantes allerede og brukes til sortering/
  filtrering, men var aldri synlig i selve listen.
- **Thumbnail i funnlisten**: hvert funn med bilde viser nå et lite
  forhåndsbilde i raden (gjenbruker samme sesjonsbeskyttede bilde-URL som
  detaljvisningen).
- **Sortering+gruppering slått sammen til to dropdowns i én rad** i stedet
  for to fulle chip-rader — sparer vertikal plass i funnlistepanelet, som
  hadde opptil fem stablede filterrader for admin.
- **Live artssøk i "Admin — arter"**: erstatter den gamle lokale
  nedtrekkslisten (kun de ~17 kuraterte artene i `species.json`) med samme
  søk mot Artsdatabanken som registreringsflyten allerede bruker
  (`/arter/sok`) — admin kan nå skjule en hvilken som helst art, ikke bare
  de som allerede er kuratert lokalt.

## 0.9.2 — Fiks: kart lastet aldri hvis #map hadde 0x0 størrelse ved oppstart
`initMapNarKlar()` (`js/app.js`) hadde allerede et dokumentert ett-forsøks
retry for det sjeldne tilfellet der `#map`-containeren har 0x0 størrelse idet
`initMap()` kjører (fitBounds kaster da "Invalid LatLng"). Retryet var i
praksis dødfødt: `L.map('map', ...)` i `js/map.js` rekker å stemple
containeren som initialisert FØR fitBounds kaster, så gjenforsøket feilet
garantert med en helt annen feil ("Map container is already initialized")
i stedet — uansett om containeren da hadde fått reell størrelse. Endte med
et helt blankt kart og en app som aldri wiret opp innlogging/funnliste/
registrering, siden alt dette venter på `initMapNarKlar()`.

Fikset i `js/map.js`: `map.remove()` i en catch rundt `fitBounds`/
`setMinZoom` rydder DOM og `_leaflet_id` slik at retry-forsøket faktisk kan
lykkes. Verifisert ved å simulere 0x0-scenarioet direkte i nettleseren
(display:none på #map) — forsøk 1 feiler som forventet, forsøk 2 (retryet)
lykkes nå rent.

## 0.9.1 — Kartzoom-grenser og lengre Mapbox-cache
Funnet ved funksjonell testing 2026-07-13: for dypt zoom ga uventede
resultater på begge kartlagene.

- **Kartverket-laget** (`js/map.js`): `maxNativeZoom: 18` lagt til. Bekreftet
  ved direkte testing at Kartverkets WMTS-matrise for Bondøya-området
  slutter på z18 — z19+ ga 400 Bad Request for alle fliser, ikke bare
  enkelte. Leaflet skalerer nå opp z18-flisen for dypere zoom i stedet for
  å be om fliser som ikke finnes.
- **Mapbox-laget** (`js/map.js`): `maxNativeZoom: 15` lagt til. Produkteier
  bekreftet visuelt at z16 er merkbart grøtete (interpolert av Mapbox).
  Sparer også Mapbox-kall (free tier) siden Leaflet ikke lenger henter
  fliser dypere enn 15 — hvert zoom-nivå dypere er ~4x flere unike fliser.
- **Cloudflare-cache for Mapbox-fliser** (`worker/api/src/routes/tiles.js`):
  `Cache-Control` økt fra 7 dager til 1 år (`immutable`) — fliser for en
  fast koordinat endrer seg aldri, så både CF-kanten og nettleseren kan
  holde på dem mye lenger uten risiko. Anbefalt i tillegg (ikke kode):
  skru på Tiered Cache i Cloudflare-dashbordet for bondoya.no, siden
  `caches.default` er per-datasenter og ellers gir cache-miss mot Mapbox
  første gang hver PoP treffes.

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
