-- Global admin-styrt bryter: skal funn i det hele tatt vises i det
-- offentlige (uinnloggede) laget? Se worker/api/src/lib/innstillinger.js.
-- Generisk nøkkel/verdi-tabell (fremfor en dedikert kolonne et sted) fordi
-- dette er global appkonfigurasjon, ikke knyttet til en enkelt rad — og gir
-- plass til flere fremtidige admin-brytere uten nye migrasjoner.
CREATE TABLE innstillinger (
  nokkel TEXT PRIMARY KEY,
  verdi TEXT NOT NULL
);

-- Standard: PÅ (uendret oppførsel fra Milestone D, kun rødliste-filtrering
-- gjaldt) inntil en admin eksplisitt skrur den av.
INSERT INTO innstillinger (nokkel, verdi) VALUES ('funn_synlig_for_public', '1');
