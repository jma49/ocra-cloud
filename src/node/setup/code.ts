import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hmacHex, sameText } from "../../crypto.js";

// The setup code opens the server's settings page to whoever runs the
// server: it is printed in the server's log while nobody can sign in, and
// `node dist/setup-code.mjs` prints it at any time. Made from SESSION_SECRET,
// so every process of a deployment shows the same one and a new secret
// changes it. Settings are the operator's, not an account's: no account
// is an administrator.

const COOKIE = "__Host-ocra_setup";
const OPEN_MS = 2 * 60 * 60_000;
// Crockford's base32: no I, L, O or U to misread.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Sixteen characters in four groups, 80 bits. */
export async function setupCode(sessionSecret: string): Promise<string> {
  const hex = await hmacHex(sessionSecret, "ocra-setup-code:v1");
  let bits = BigInt(`0x${hex.slice(0, 20)}`);
  let code = "";
  for (let i = 0; i < 16; i++) {
    code = ALPHABET[Number(bits & 31n)] + code;
    bits >>= 5n;
  }
  return code.match(/.{4}/g)?.join("-") ?? code;
}

/** The code as people type it: any case, with or without its dashes and spaces. */
export async function isSetupCode(sessionSecret: string, typed: string): Promise<boolean> {
  const plain = (s: string) => s.toUpperCase().replace(/[\s-]/g, "");
  return sameText(plain(typed), plain(await setupCode(sessionSecret)));
}

const cookieMac = (secret: string, until: number) =>
  hmacHex(secret, `ocra-setup-cookie:v1|${until}`);

/** Opens the settings to this browser for two hours. */
export async function openSettings(c: Context, sessionSecret: string, now: Date): Promise<void> {
  const until = now.getTime() + OPEN_MS;
  setCookie(c, COOKIE, `${until}.${await cookieMac(sessionSecret, until)}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: OPEN_MS / 1000,
  });
}

/** Whether this browser opened the settings with the code lately. */
export async function settingsOpen(c: Context, sessionSecret: string, now: Date) {
  const [until = "", mac = ""] = (getCookie(c, COOKIE) ?? "").split(".");
  const ends = Number(until);
  if (!Number.isSafeInteger(ends) || ends <= now.getTime()) return false;
  return sameText(mac, await cookieMac(sessionSecret, ends));
}
