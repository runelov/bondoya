// Global admin-styrt appkonfigurasjon — se migrations/0005. Generisk
// nøkkel/verdi i D1 fremfor én dedikert kolonne et sted, for å gi plass til
// flere fremtidige admin-brytere uten nye migrasjoner.
const NOKKEL_FUNN_SYNLIG_FOR_PUBLIC = 'funn_synlig_for_public';

// Fail-closed dersom raden mangler (burde aldri skje etter migrations/0005,
// men samme prinsipp som lib/artsvisibility.js: ukjent tilstand er IKKE
// "trygt å vise offentlig").
export async function erFunnSynligForPublic(env) {
  const rad = await env.DB.prepare('SELECT verdi FROM innstillinger WHERE nokkel = ?')
    .bind(NOKKEL_FUNN_SYNLIG_FOR_PUBLIC)
    .first();
  return rad?.verdi === '1';
}

export async function settFunnSynligForPublic(env, verdi) {
  await env.DB.prepare(
    `INSERT INTO innstillinger (nokkel, verdi) VALUES (?, ?)
     ON CONFLICT(nokkel) DO UPDATE SET verdi = excluded.verdi`
  )
    .bind(NOKKEL_FUNN_SYNLIG_FOR_PUBLIC, verdi ? '1' : '0')
    .run();
}
