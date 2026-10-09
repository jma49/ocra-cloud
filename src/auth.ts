import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { randomToken } from "./crypto.js";
import { upsertAccount } from "./db/accounts.js";
import { deadline } from "./deadline.js";
import { apiError } from "./http.js";
import {
  clearSessionCookie,
  requireSession,
  setSessionCookie,
  startWebSession,
} from "./session.js";
import type { AppEnv } from "./types.js";

// Signing in with GitHub, and signing out.

// `__Host-` needs Path=/, so the state cookie is sent site-wide for its ten
// minutes; in return a sibling subdomain cannot plant a state it signed
// for itself and finish a sign-in as its own account in this browser.
const STATE_COOKIE = "__Host-ocra_oauth_state";
const STATE_OPTIONS = { secure: true, path: "/" } as const;

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

export const auth = new Hono<AppEnv>();

function callbackUrl(requestUrl: string): string {
  return new URL("/api/auth/github/callback", requestUrl).toString();
}

/** How long each GitHub call at sign-in may take, its answer read (audit C5). */
const GITHUB_TIMEOUT_MS = 10_000;

/** A GitHub call's JSON answer; null when it failed, was refused or took too long. */
async function github<T>(url: string, init: RequestInit): Promise<T | null> {
  const clock = deadline(GITHUB_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: clock.signal });
    const body = (await res.json()) as T;
    return res.ok ? body : null;
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}

auth.get("/github/login", async (c) => {
  const state = randomToken("");
  const next = safeNext(c.req.query("next"));
  await setSignedCookie(c, STATE_COOKIE, `${state} ${next}`, c.env.SESSION_SECRET, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 600,
    ...STATE_OPTIONS,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return c.redirect(url.toString(), 302);
});

auth.get("/github/callback", async (c) => {
  const cookie = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, STATE_OPTIONS);
  const space = cookie ? cookie.indexOf(" ") : -1;
  const expected = cookie && space > 0 ? cookie.slice(0, space) : cookie || undefined;
  const next = cookie && space > 0 ? cookie.slice(space + 1) : undefined;
  const { code, state } = c.req.query();
  if (!code || !state || !expected || state !== expected) {
    return apiError(c, "bad_state");
  }
  const tokenBody = await github<{ access_token?: string }>(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl(c.req.url),
      }),
    },
  );
  if (!tokenBody?.access_token) return apiError(c, "github_exchange");
  // The GitHub token is used once, to learn who signed in, and not kept.
  const user = await github<{ id?: number; login?: string }>("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "ocra-cloud",
    },
  });
  if (typeof user?.id !== "number" || typeof user.login !== "string") {
    return apiError(c, "github_user");
  }
  const account = await upsertAccount(c.var.db, user.id, user.login);
  const token = await startWebSession(c.var.db, account.id);
  setSessionCookie(c, token);
  return c.redirect(safeNext(next), 302);
});

auth.post("/logout", requireSession(["web", "cli"]), async (c) => {
  await c.var.data.remove("sessions", c.var.session.sessionId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
