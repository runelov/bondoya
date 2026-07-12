-- Offentlig (ikke-innlogget) lag: rødlistede/sensitive arter skal filtreres
-- i selve D1-spørringen, ikke i JS. Se konsept.md "Artssynlighet for
-- offentlige besøkende" og Milestone D-planen.
ALTER TABLE funn ADD COLUMN synlig_for_public INTEGER NOT NULL DEFAULT 1;

-- Backfill for funn registrert før denne kolonnen fantes. taxonId-ene under
-- er de 7 artene i data/species.json med synligForPublic:false (rødlistet
-- NT/VU/EN 2026-07-12): Ærfugl, Storskarv, Teist, Krykkje, Gråmåke,
-- Fiskemåke, Tjeld.
UPDATE funn SET synlig_for_public = 0
WHERE art_taxon_id IN (3491, 3863, 3562, 203546, 3624, 3628, 203529);
