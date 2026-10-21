/**
 * Signed, expiring session token for the optional app password.
 * Uses Web Crypto so it runs in the request proxy and in route handlers.
 * Format: <expiresAtMs>.<base64url HMAC-SHA256>
 */
export const SESSION_COOKIE = "scaper_session";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSessionToken(secret: string, days = SESSION_DAYS) {
  const exp = String(Date.now() + days * 86400_000);
  return `${exp}.${await hmac(secret, exp)}`;
}

export async function verifySessionToken(secret: string, token: string | undefined | null) {
  if (!token || !secret) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = await hmac(secret, exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
