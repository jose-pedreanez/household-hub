/**
 * Household session cookies: `base64url(payload).base64url(HMAC-SHA256(payload))`.
 * Uses Web Crypto only, so the same code runs in the proxy and in route handlers.
 */

export const SESSION_COOKIE = "hub_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

interface SessionPayload {
  v: 1;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createSessionToken(secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload: SessionPayload = { v: 1, iat: nowSeconds, exp: nowSeconds + SESSION_TTL_SECONDS };
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!token) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  try {
    const sigBytes = fromB64url(sig);
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer,
      encoder.encode(body),
    );
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    return payload.v === 1 && payload.exp > nowSeconds;
  } catch {
    return false;
  }
}

/** Constant-time comparison of two secrets (lengths may differ). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
