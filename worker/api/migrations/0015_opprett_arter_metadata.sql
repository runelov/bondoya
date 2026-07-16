-- Erstatter data/species.json sin "beskrivelse"-felt, som i praksis begrenset
-- artsomtaler til de 17 opprinnelig kuraterte artene — aldri intensjonen
-- (se CHANGELOG 0.9.14). Artsomtale er nå et eget, admin-redigerbart
-- oppslag per taxonId, uavhengig av funn-tabellen: mange funn deler samme
-- art, så omtalen lagres én gang per art (ikke duplisert per funn), og en
-- senere rettelse forbedrer visningen for ALLE tidligere funn av arten, ikke
-- bare fremtidige.
--
-- kilde skiller admin-skrevet tekst (autoritativ, overskrives aldri
-- automatisk) fra en Wikipedia-hentet reserveløsning (kan overskrives av en
-- senere Wikipedia-oppfrisking) — se hentArtsbeskrivelse() i routes/arter.js.
CREATE TABLE arter_metadata (
  taxon_id INTEGER PRIMARY KEY,
  beskrivelse TEXT NOT NULL,
  kilde TEXT NOT NULL CHECK (kilde IN ('admin', 'wikipedia')),
  wikipedia_url TEXT,
  oppdatert_av_bruker_id INTEGER REFERENCES brukere(id),
  oppdatert TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Frø fra de 17 tidligere hardkodede beskrivelsene i data/species.json —
-- forfattet av appens utvikler, ikke hentet fra noen API (bekreftet
-- 2026-07-16: Artsdatabankens taxon-endepunkt har ingen fritekstbeskrivelse
-- i det hele tatt). Bevart som kilde='admin' fremfor å kastes.
INSERT INTO arter_metadata (taxon_id, beskrivelse, kilde) VALUES
  (31241, 'Norges største landpattedyr. Uvanlig, men bekreftet forekommende på Bondøya — elg er en god svømmer og krysser av og til korte sund til kystnære øyer.', 'admin'),
  (3491, 'Stor, kraftig bygd dykkand. Hannen er hvit/svart med lysegrønn nakke, hunnen brunspraglet. Hekker tallrikt på skjær og holmer i kystnære farvann.', 'admin'),
  (3436, 'Norges vanligste gås. Gråbrun med rosa nebb og ben, hekker på holmer og i strandnær vegetasjon.', 'admin'),
  (203576, 'Mørk, glinsende skarv med tynt nebb og (om våren) en liten fjærtopp i pannen. Hekker i kolonier på bratte svaberg.', 'admin'),
  (3863, 'Større enn toppskarv, med gult ansiktsfelt og (hos voksne) hvit strupeflekk. Sees ofte sittende med utstrakte vinger for å tørke fjærdrakten.', 'admin'),
  (3562, 'Liten alkefugl, sort med store hvite vingefelt og knallrøde ben. Hekker i fjellsprekker og steinurer nær sjøen.', 'admin'),
  (203546, 'Liten, elegant måke med korte, sorte ben og navnet etter lyden av lokkelåten. Hekker i tette kolonier på smale hyller i bratte fjell.', 'admin'),
  (3624, 'Stor, lys måke med rosa ben og gult nebb med rød flekk. Den vanligste store måken langs kysten.', 'admin'),
  (3640, 'Verdens største måke. Nesten sort overside, hvit underside, kraftig gult nebb. Toppredator blant sjøfuglene, tar gjerne egg og unger av andre arter.', 'admin'),
  (3628, 'Middels stor måke, mindre og mer spinkel enn gråmåke, med grønngult (ikke rødflekket) nebb.', 'admin'),
  (3631, 'Ligner gråmåke, men med mørk (skifergrå til sort) overside og gule ben. Trekkfugl som normalt overvintrer sørover.', 'admin'),
  (203529, 'Iøynefallende svart/hvit vadefugl med langt, rødt nebb og rosa ben. Vanlig og høylytt på strandenger og svaberg.', 'admin'),
  (3457, 'Innført art, stor gås med karakteristisk sort hals/hode og hvit «hakestropp». Ses stadig oftere langs norskekysten.', 'admin'),
  (3815, 'Norges største rovfugl, med et vingespenn på over 2 meter. Standfugl i området, kjennetegnet ved korte, kileformede hvite stjertfjær hos voksne.', 'admin'),
  (31199, 'Den vanligste selarten langs norskekysten. Hviler ofte flokkvis på skjær og holmer ved lavvann, spraglete gråbrun pels.', 'admin'),
  (214548, 'Brunalge med langt, bølget, udelt blad. Danner tett tareskog i grunne, næringsrike kystfarvann og er viktig leveområde for mye annet marint liv.', 'admin'),
  (214542, 'Brunalge med bladet delt i fingerlignende flak. Vokser typisk grunnere enn sukkertare, ofte der bølgeeksponeringen er større.', 'admin');
