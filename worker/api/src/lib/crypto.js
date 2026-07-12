// timingSafeEqual portert fra worker/ki-proxy/src/index.js.
// randomToken/sha256Hex er nye — begge brukes for magic-link-tokens og
// sesjons-ID-er: høy-entropi tilfeldig verdi sendes til klienten/e-posten,
// kun SHA-256-hashen av den lagres i D1 (se konsept.md "Auth"-avsnittet).

export function randomToken() {
  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function base64UrlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
