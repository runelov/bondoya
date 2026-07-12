-- Generisk redaksjonelt sidesystem — se konsept.md "Generisk sidesystem"
-- (linje 194-197). Erstatter tanken om faste "Om Bondøya"/"Om husene"-sider
-- med et vilkårlig antall admin-redigerbare sider, hver med egen synlighet
-- og status.
CREATE TABLE sider (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  tittel TEXT NOT NULL,
  innhold TEXT NOT NULL,
  synlighet TEXT NOT NULL CHECK (synlighet IN ('offentlig','palogget')) DEFAULT 'palogget',
  status TEXT NOT NULL CHECK (status IN ('kladd','publisert')) DEFAULT 'kladd',
  opprettet TEXT NOT NULL DEFAULT (datetime('now')),
  oppdatert TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personvern-siden er skyldig siden Milestone A begynte å lagre ekte
-- e-post/kortnavn (se konsept.md linje 144-149) — seedes publisert og
-- offentlig med et førsteutkast produkteier kan finpusse selv via
-- adminpanelet, uten en ny deploy.
INSERT INTO sider (slug, tittel, innhold, synlighet, status) VALUES (
  'personvern',
  'Personvern',
  'Denne siden forklarer hvilke personopplysninger Bondøya lagrer, og hvorfor.

Når du logger inn lagrer vi kortnavnet og e-postadressen du er invitert med. E-postadressen din er kun synlig for administrator og brukes til innloggingslenker. Kortnavnet ditt vises til andre innloggede brukere ved siden av funn du registrerer (f.eks. "registrert av Rune").

Funn du registrerer (art, posisjon, tidspunkt og eventuelt bilde) lagres i Cloudflare D1 (database) og R2 (bildelagring). Rødlistede og enkelte andre arter vises ikke i den offentlige, uinnloggede visningen.

Hvis du bruker automatisk artsgjenkjenning sendes bildet til Anthropics Claude (via vår egen mellomtjener) for å foreslå en art. Ingen andre personopplysninger enn selve bildet sendes dit.

Kartutsnitt (satellittbilder) hentes fra Mapbox — disse forespørslene inneholder ingen personopplysninger, kun hvilket kartutsnitt som vises.

Innloggingslenker sendes på e-post via Resend, som dermed mottar e-postadressen din og selve lenken.

Vi selger eller deler ikke opplysningene dine med noen andre formål. Ønsker du å få kontoen din permanent slettet, ta kontakt med administrator.',
  'offentlig',
  'publisert'
);
