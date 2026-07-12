// Sender innloggingslenke via Resend. Uten RESEND_API_KEY, eller utenfor
// ENVIRONMENT=production (lokal wrangler dev), logges lenken til konsollen
// i stedet for å faktisk sendes — se README.md for hvordan dette brukes til
// å teste hele auth-flyten uten en ekte e-postinnboks.
export async function sendInnloggingsLenke(epost, lenkeUrl, env) {
  if (!env.RESEND_API_KEY || env.ENVIRONMENT !== 'production') {
    console.log(`[dev] Innloggingslenke for ${epost}: ${lenkeUrl}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // mail.bondoya.no (ikke rot-domenet) er verifisert i Resend — Resend
      // sin egen anbefaling er en subdomene for sending, slik at eventuelle
      // leveringsproblemer ikke påvirker bondoya.no sitt generelle omdømme.
      from: 'Bondøya <innlogging@mail.bondoya.no>',
      to: epost,
      subject: 'Logg inn på Bondøya',
      html: `<p>Klikk for å logge inn: <a href="${lenkeUrl}">${lenkeUrl}</a></p><p>Lenken er gyldig i 15 minutter og kan kun brukes én gang.</p>`,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend-sending feilet (${res.status}): ${text}`);
  }
}
