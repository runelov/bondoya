// Server-side verifisering av Cloudflare Turnstile, se konsept.md
// "Sikring av innloggingssiden". Kjøres FØR noe annet (rate-limit,
// e-post-oppslag) i /auth/be-om-lenke.
export async function verifyTurnstile(token, ip, env) {
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    // Nettverksfeil mot Turnstile behandles som avslag, ikke som "hopp over
    // sjekken" — samme føre-var-prinsipp som resten av auth-koden.
    return false;
  }
}
