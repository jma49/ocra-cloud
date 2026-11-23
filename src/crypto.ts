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

// What each other sealed row is bound to; kept here beside keyBinding and
// SEALED_KINDS so that a rotation re-wraps every kind with the binding the
// service opens it with.

/** An account's token on a code platform: the account, the platform and its host. */
export const platformTokenBinding = (accountId: string, platform: string, host: string) =>
  `ocra-platform-token:v1|${accountId}|${platform}|${host}`;

/** An enrolled repository's own access token: the account and the repository's row. */
export const repoTokenBinding = (accountId: string, repoId: string) =>
  `ocra-repo-token:v1|${accountId}|${repoId}`;

/** A notification channel's address: the account and the channel's row. */
export const channelBinding = (accountId: string, channelId: string) =>
  `ocra-notify-channel:v1|${accountId}|${channelId}`;

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

type Row = Record<string, unknown>;

/**
 * A table's sealed columns and what each row is bound to: the binding must
 * be the one the service opens the row with, or the row would not open.
 */
export type SealedKind = {
  table: string;
  /** The columns that name a row, its primary key. */
  key: string[];
  wrapped: string;
  ciphertext: string;
  columns: string[];
  binding(row: Row): string;
};

const s = (v: unknown) => String(v);

/** Every table a master key seals, read by both rotation tools (docs/rotation.md). */
const SEALED_KINDS: readonly SealedKind[] = [
  {
    table: "provider_keys",
    key: ["id"],
    wrapped: "wrapped_key",
    ciphertext: "ciphertext",
    columns: ["account_id", "provider"],
    binding: (r) => keyBinding(s(r.account_id), s(r.provider)),
  },
  {
    table: "platform_links",
    key: ["account_id", "platform", "host"],
    wrapped: "wrapped_key",
    ciphertext: "ciphertext",
    columns: ["account_id", "platform", "host"],
    binding: (r) => platformTokenBinding(s(r.account_id), s(r.platform), s(r.host)),
  },
  {
    table: "review_repos",
    key: ["id"],
    wrapped: "access_token_wrapped_key",
    ciphertext: "access_token_ciphertext",
    columns: ["account_id", "id"],
    binding: (r) => repoTokenBinding(s(r.account_id), s(r.id)),
  },
  {
    // Every kind of channel, a Slack member's direct messages included.
    table: "notify_channels",
    key: ["id"],
    wrapped: "wrapped_key",
    ciphertext: "ciphertext",
    columns: ["account_id", "id"],
    binding: (r) => channelBinding(s(r.account_id), s(r.id)),
  },
];

/** Rows read, and updates written, per round trip to the database. */
export const REWRAP_BATCH = 200;

/** A sealed row as a store reads it: its values, and how the store finds it again. */
type SealedRow<Ref> = { ref: Ref; values: Row };

/** One row's compare-and-set: its wrapped key becomes `to` only while it is still `from`. */
type Rewrapped<Ref> = { ref: Ref; from: string; to: string };

/** Where the sealed rows live: D1 through wrangler, or a self-hosted server's database. */
export type SealedStore<Ref> = {
  /** The kind's rows with a wrapped key, REWRAP_BATCH at a time, each page after the last. */
  pages(kind: SealedKind): AsyncIterable<SealedRow<Ref>[]>;
  /** At most REWRAP_BATCH compare-and-set updates of the kind's rows. */
  write(kind: SealedKind, updates: Rewrapped<Ref>[]): Promise<void>;
  /** How a failed row is named in the output: never anything it seals. */
  label(ref: Ref): string;
};

const BASE64 = /^[A-Za-z0-9+/=]+$/;

const opens = (key: string, wrappedKey: string, ciphertext: string, binding: string) =>
  decryptSecret(key, { wrappedKey, ciphertext }, binding).then(
    (plain) => plain,
    () => undefined,
  );

type Scan<Ref> = { updates: [SealedKind, Rewrapped<Ref>[]][]; pending: number; failed: number };

/** Each row's compare-and-set, or why it gets none: already re-wrapped, or failed. */
async function scan<Ref>(
  store: SealedStore<Ref>,
  keys: { old: string; new: string },
): Promise<Scan<Ref>> {
  const out: Scan<Ref> = { updates: [], pending: 0, failed: 0 };
  for (const kind of SEALED_KINDS) {
    const tally = { rows: 0, done: 0, failed: 0 };
    const updates: Rewrapped<Ref>[] = [];
    for await (const page of store.pages(kind)) {
      for (const { ref, values } of page) {
        tally.rows++;
        const wrapped = s(values[kind.wrapped]);
        const ciphertext = s(values[kind.ciphertext]);
        const binding = kind.binding(values);
        try {
          if (!BASE64.test(wrapped)) throw new Error("unexpected value");
          const before = await opens(keys.old, wrapped, ciphertext, binding);
          if (before === undefined) {
            // Re-wrapped by an earlier run, or written by the service under the new key.
            if ((await opens(keys.new, wrapped, ciphertext, binding)) === undefined) {
              throw new Error("opens with neither key");
            }
            tally.done++;
            continue;
          }
          const next = await rewrap(keys.old, keys.new, wrapped, binding);
          // The point of the rotation: the new key must open what the old one did.
          if ((await opens(keys.new, next, ciphertext, binding)) !== before) {
            throw new Error("mismatch");
          }
          if (!BASE64.test(next)) throw new Error("unexpected value");
          updates.push({ ref, from: wrapped, to: next });
        } catch {
          tally.failed++;
          console.error(
            `${kind.table} ${store.label(ref)}: opens with neither key, or does not verify with the new one`,
          );
        }
      }
    }
    console.log(
      `${kind.table}: ${tally.rows} row(s), ${updates.length} to re-wrap, ${tally.done} already under the new key, ${tally.failed} failed`,
    );
    out.updates.push([kind, updates]);
    out.pending += updates.length;
    out.failed += tally.failed;
  }
  return out;
}

/**
 * Re-wraps every sealed row's data key from the old master key to the new
 * one; without apply it only checks. A row that opens with neither key
 * stops the run before anything is written; after writing, every row is
 * read back and must open with the new key. Answers the exit code. Prints
 * counts and row names, never a key or what a row seals.
 */
export async function rotateMasterKey<Ref>(
  store: SealedStore<Ref>,
  keys: { old: string; new: string },
  apply: boolean,
): Promise<0 | 1> {
  const first = await scan(store, keys);
  if (first.failed > 0) return 1;
  if (!apply) {
    console.log(
      first.pending > 0 ? "Checked only. Run again with --apply to write." : "Nothing to re-wrap.",
    );
    return 0;
  }
  for (const [kind, updates] of first.updates) {
    for (let i = 0; i < updates.length; i += REWRAP_BATCH) {
      await store.write(kind, updates.slice(i, i + REWRAP_BATCH));
    }
  }
  // Read back: every row must now open with the new key.
  const after = await scan(store, keys);
  if (after.failed > 0 || after.pending > 0) {
    console.error("Some rows still open only with the old key: run again with --apply.");
    return 1;
  }
  console.log("Every sealed row opens with the new key. Next: remove MASTER_KEY_PREVIOUS.");
  return 0;
}
