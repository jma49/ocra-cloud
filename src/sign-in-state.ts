import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { randomToken } from "./crypto.js";
import type { AppEnv } from "./types.js";

// What a sign-in carries from its start to the provider's callback: the
// state the callback must echo, the page to return to, and for OpenID
// Connect the PKCE verifier.

// `__Host-` needs Path=/, so the state cookie is sent site-wide for its ten
// minutes; in return a sibling subdomain cannot plant a state it signed
// for itself and finish a sign-in as its own account in this browser.
const STATE_COOKIE = "__Host-ocra_oauth_state";
const STATE_OPTIONS = { secure: true, path: "/" } as const;

type SignInState = { state: string; next: string; verifier?: string };

const unsafeChar = (ch: string) => ch.charCodeAt(0) < 0x20 || ch === "\x7f" || ch === "\\";

/**
 * A path on this site to return to after sign-in, or "/". Browsers drop tabs
 * and newlines from a URL and read a backslash as a slash, so "/\t/evil.example"
 * would leave the site: those are refused, and what remains must resolve to
 * a path on this origin that does not start with "//".
 */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith("/") || next.length > 512 || [...next].some(unsafeChar)) return "/";
  const base = "https://ocra.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  // Checked on the output too: dot segments resolve, so "/.//evil.example"
  // becomes the path "//evil.example", which a browser reads as a host.
  if (url.origin !== base || url.pathname.startsWith("//")) return "/";
  return url.pathname + url.search + url.hash;
}

/** Signs a new sign-in's state into its cookie; answers the state to send the provider. */
export async function startSignIn(
  c: Context<AppEnv>,
  extra: { verifier?: string } = {},
): Promise<string> {
  const value: SignInState = {
    state: randomToken(""),
    next: safeNext(c.req.query("next")),
    ...extra,
  };
  await setSignedCookie(c, STATE_COOKIE, JSON.stringify(value), c.env.SESSION_SECRET, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 600,
    ...STATE_OPTIONS,
  });
  return value.state;
}

/**
 * The sign-in a callback finishes, when its `state` matches the cookie's; the
 * cookie is spent either way. Undefined for a missing, forged or stale state.
 */
export async function finishSignIn(c: Context<AppEnv>): Promise<SignInState | undefined> {
  const cookie = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, STATE_OPTIONS);
  const state = c.req.query("state");
  if (!cookie || !state) return undefined;
  let saved: Partial<SignInState>;
  try {
    saved = JSON.parse(cookie);
  } catch {
    return undefined;
  }
  if (typeof saved.state !== "string" || saved.state !== state) return undefined;
  return {
    state,
    next: safeNext(saved.next),
    ...(typeof saved.verifier === "string" ? { verifier: saved.verifier } : {}),
  };
}
