-- Autentisering: brukere, engangs-innloggingstokens, sesjoner.
-- Se konsept.md ("Auth"-avsnittet) for sikkerhetsbegrunnelsen bak valgene
-- her (sesjonsbasert ikke JWT, kun hash lagres, ingen signeringsnøkkel).

CREATE TABLE brukere (
  id INTEGER PRIMARY KEY,
  epost TEXT NOT NULL UNIQUE,
  kortnavn TEXT NOT NULL,
  rolle TEXT NOT NULL DEFAULT 'bruker' CHECK (rolle IN ('bruker','admin')),
  status TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','deaktivert')),
  opprettet TEXT NOT NULL DEFAULT (datetime('now'))
);

-- utloper: unix-epoch MILLISEKUNDER (INTEGER), satt fra Worker (Date.now()).
-- Bevisst ikke SQL datetime()/TEXT — å sammenligne en JS ISO-streng mot en
-- SQL-generert datetime()-streng med </> gir feil resultat pga.
-- tegnsammenligning ('T' sorterer alltid over mellomrom).
CREATE TABLE innloggingstokens (
  hash TEXT PRIMARY KEY,
  bruker_id INTEGER NOT NULL REFERENCES brukere(id) ON DELETE CASCADE,
  utloper INTEGER NOT NULL,
  brukt INTEGER NOT NULL DEFAULT 0,
  opprettet TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_innloggingstokens_bruker ON innloggingstokens(bruker_id);

CREATE TABLE sesjoner (
  hash TEXT PRIMARY KEY,
  bruker_id INTEGER NOT NULL REFERENCES brukere(id) ON DELETE CASCADE,
  utloper INTEGER NOT NULL,
  opprettet TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sesjoner_bruker ON sesjoner(bruker_id);
