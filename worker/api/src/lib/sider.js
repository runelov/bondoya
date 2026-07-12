export const SYNLIGHETER = ['offentlig', 'palogget'];
export const STATUSER = ['kladd', 'publisert'];

const MAKS_TITTEL_LENGDE = 200;
const MAKS_INNHOLD_LENGDE = 20000;
const SLUG_REGEX = /^[a-z0-9-]+$/;

export function parseSideRad(rad) {
  return {
    id: rad.id,
    slug: rad.slug,
    tittel: rad.tittel,
    innhold: rad.innhold,
    synlighet: rad.synlighet,
    status: rad.status,
    opprettet: rad.opprettet,
    oppdatert: rad.oppdatert,
  };
}

// Formen offentlige/pålogget-uten-admin-rolle besøkende får se — samme
// utelat-felt-prinsipp som parseFunnRadOffentlig i lib/funn.js. `status` er
// alltid 'publisert' og trenger ikke sendes med (kun admin ser kladder).
export function parseSideRadOffentlig(rad) {
  return {
    slug: rad.slug,
    tittel: rad.tittel,
    innhold: rad.innhold,
    synlighet: rad.synlighet,
  };
}

// Avgjør om en side (rad fra D1) skal vises for kallende part. `bruker` er
// null for uinnlogget/ugyldig sesjon — se den myke sesjonssjekken i
// routes/sider.js.
export function erSideSynligFor(rad, bruker) {
  if (rad.status !== 'publisert') return false;
  if (rad.synlighet === 'offentlig') return true;
  return !!bruker;
}

// Validerer feltene som er felles for opprettelse og redigering. Kaster en
// Error med brukervennlig norsk melding ved ugyldig input — rutene fanger
// denne og returnerer 400. Samme mønster som validerFunnFelter i lib/funn.js.
export function validerSideFelter(felter) {
  const slug = (felter.slug || '').trim().toLowerCase();
  if (!slug) throw new Error('Slug mangler.');
  if (!SLUG_REGEX.test(slug)) throw new Error('Slug kan kun inneholde små bokstaver, tall og bindestrek.');
  if (slug.length > 100) throw new Error('Slug er for lang.');

  const tittel = (felter.tittel || '').trim();
  if (!tittel) throw new Error('Tittel mangler.');
  if (tittel.length > MAKS_TITTEL_LENGDE) throw new Error('Tittel er for lang.');

  const innhold = (felter.innhold || '').trim();
  if (!innhold) throw new Error('Innhold mangler.');
  if (innhold.length > MAKS_INNHOLD_LENGDE) throw new Error('Innhold er for langt.');

  const synlighet = felter.synlighet;
  if (!SYNLIGHETER.includes(synlighet)) throw new Error('Ugyldig synlighet.');

  const status = felter.status;
  if (!STATUSER.includes(status)) throw new Error('Ugyldig status.');

  return { slug, tittel, innhold, synlighet, status };
}
