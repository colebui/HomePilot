/**
 * Signed session cookies for the live dashboard, using Web Crypto so the same code runs in Proxy
 * and in Server Components. A session is "<expiry ms>.<HMAC-SHA256 of the expiry>", so it carries
 * no data worth stealing and cannot be forged or extended without the secret.
 */

export const SESSION_COOKIE = "hp_dash_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The signing secret: an explicit one, or one derived from the API token so setup needs one value. */
export async function sessionSecret(opts: { explicit?: string; apiToken?: string }): Promise<string> {
  if (opts.explicit) return opts.explicit;
  if (!opts.apiToken) throw new Error("no session secret available");
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(`homepilot-dashboard-session:${opts.apiToken}`)));
}

export async function signSession(secret: string, expiresAtMs: number): Promise<string> {
  const payload = `v1:${expiresAtMs}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${expiresAtMs}.${toHex(sig)}`;
}

export async function verifySession(secret: string, value: string | undefined, nowMs: number): Promise<boolean> {
  if (!value) return false;
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const expiresAt = Number(m[1]);
  if (!(expiresAt > nowMs)) return false;
  const sig = Uint8Array.from(m[2]!.match(/../g)!.map((h) => parseInt(h, 16)));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`v1:${expiresAt}`));
}

/** Constant-time comparison for the login password, via HMAC so lengths do not leak either. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = await hmacKey("homepilot-compare");
  const [ha, hb] = await Promise.all([crypto.subtle.sign("HMAC", key, enc.encode(a)), crypto.subtle.sign("HMAC", key, enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
