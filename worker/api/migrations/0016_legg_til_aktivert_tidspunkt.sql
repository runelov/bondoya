-- Skiller "registrert" (raden finnes i brukere, typisk fra en invitasjon
-- eller admin-opprettelse — sier ingenting om personen faktisk har prøvd å
-- logge inn) fra "aktivert" (personen har selv lagt inn sin e-post i appen
-- og trigget en innloggingslenke til seg selv, jf. brukertilbakemelding
-- 2026-07-16). NULL = registrert, men aldri aktivert.
--
-- Bevisst en enkel ALTER TABLE ADD COLUMN (ingen CHECK-constraint å bygge
-- om, ulikt funn.artstype-migrasjonene 0011/0013/0014) — nullable TEXT-
-- tidsstempel, samme datetime('now')-konvensjon som resten av skjemaet.
ALTER TABLE brukere ADD COLUMN aktivert_tidspunkt TEXT;
