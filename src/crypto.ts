// Envelope encryption for provider keys (ADR-0024): each secret is encrypted
// with its own AES-256-GCM data key, and the data key is encrypted (wrapped)
// with the master key, a Worker secret. Both are stored as base64 of
// iv (12 bytes) followed by the ciphertext and tag.

const enc = new TextEncoder();
const dec = new TextDecoder();

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA-256 of text under secret, as hex: a name for a value that must not be stored. */
export async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether two strings are equal, in time that depends only on their length. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 code challenge of a PKCE verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("an AES-256 key is 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Additional data binds a sealed key to its row: it opens only for the
// account and provider it was sealed for (#16).
const gcm = (iv: Uint8Array<ArrayBuffer>, aad?: string) =>
  aad === undefined
    ? { name: "AES-GCM", iv }
    : { name: "AES-GCM", iv, additionalData: enc.encode(aad) };

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, aad), key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

async function open(
  key: CryptoKey,
  sealed: string,
  aad?: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = fromBase64(sealed);
  const iv = bytes.slice(0, 12);
  return new Uint8Array(await crypto.subtle.decrypt(gcm(iv, aad), key, bytes.slice(12)));
}

/** What a provider key is bound to: the account and provider of its row. */
export function keyBinding(accountId: string, provider: string): string {
  return `ocra-provider-key:v1|${accountId}|${provider}`;
}

export type Sealed = { wrappedKey: string; ciphertext: string };

export async function encryptSecret(
  masterKey: string,
  secret: string,
  binding?: string,
): Promise<Sealed> {
  const master = await aesKey(fromBase64(masterKey));
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await seal(await aesKey(dataKey), new Uint8Array(enc.encode(secret)), binding);
  const wrappedKey = await seal(master, dataKey, binding);
  return { wrappedKey, ciphertext };
}

export async function decryptSecret(
  masterKey: string,
  sealed: Sealed,
  binding?: string,
): Promise<string> {
  const master = await aesKey(fromBase64(masterKey));
  const dataKey = await open(master, sealed.wrappedKey, binding);
  return dec.decode(await open(await aesKey(dataKey), sealed.ciphertext, binding));
}

/** The master key, and during a rotation the one it replaces. */
export type MasterKeys = { current: string; previous?: string | undefined };

/**
 * Decrypts a key bound to its row, with the current master key, else the
 * previous one (rotation). Every stored key is bound (#16): an unbound one
 * no longer opens.
 */
export async function decryptWithAny(
  keys: MasterKeys,
  sealed: Sealed,
  binding: string,
): Promise<string> {
  try {
    return await decryptSecret(keys.current, sealed, binding);
  } catch (error) {
    if (!keys.previous) throw error;
    return decryptSecret(keys.previous, sealed, binding);
  }
}

/** The data key re-wrapped under a new master key; the ciphertext is unchanged. */
export async function rewrap(
  oldMaster: string,
  newMaster: string,
  wrappedKey: string,
  binding?: string,
): Promise<string> {
  const dataKey = await open(await aesKey(fromBase64(oldMaster)), wrappedKey, binding);
  return seal(await aesKey(fromBase64(newMaster)), dataKey, binding);
}
