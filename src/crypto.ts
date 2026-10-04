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

export function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("an AES-256 key is 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

async function open(key: CryptoKey, sealed: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = fromBase64(sealed);
  const iv = bytes.slice(0, 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes.slice(12)));
}

export type Sealed = { wrappedKey: string; ciphertext: string };

export async function encryptSecret(masterKey: string, secret: string): Promise<Sealed> {
  const master = await aesKey(fromBase64(masterKey));
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await seal(await aesKey(dataKey), new Uint8Array(enc.encode(secret)));
  const wrappedKey = await seal(master, dataKey);
  return { wrappedKey, ciphertext };
}

export async function decryptSecret(masterKey: string, sealed: Sealed): Promise<string> {
  const master = await aesKey(fromBase64(masterKey));
  const dataKey = await open(master, sealed.wrappedKey);
  return dec.decode(await open(await aesKey(dataKey), sealed.ciphertext));
}
