import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "./crypto.js";
import {
  revokeSession,
  rotateSession,
  sessionByRefreshHash,
  sessionByTokenHash,
  upsertAccount,
} from "./db/accounts.js";
import { scoped } from "./db/scoped.js";
import type { AppEnv } from "./types.js";

export const SESSION_COOKIE = "ocra_session";
const STATE_COOKIE = "ocra_oauth_state";
const DAY = 86_400_000;
export const SESSION_DAYS = { web: 30, cli: 90 } as const;
/** A CLI access token lives an hour; its refresh token, SESSION_DAYS.cli. */
const CLI_ACCESS_MS = 3_600_000;
/** How long a refresh token used once still answers, for a response that was lost. */
export const REFRESH_GRACE_MS = 60_000;

type Kind = "web" | "cli";

/**
 * The signed-in account, from the session cookie (the web app) or a bearer
 * token (the CLI). A cookie request that changes something must come from
 * this origin: JSON requests from elsewhere already need a CORS preflight,
 * which this API never grants, and the Origin check covers the rest.
 */
export function requireSession(kinds: readonly Kind[] = ["web"]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const token = bearer ?? getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    if (!bearer && !["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== new URL(c.req.url).origin) return c.json({ error: "bad_origin" }, 403);
    }
    const session = await sessionByTokenHash(c.var.db, await sha256Hex(token));
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    // A CLI token reaches only what the CLI needs (ADR-0024): never keys,
    // sessions or the account.
    if (!kinds.includes(session.kind)) return c.json({ error: "forbidden_for_session" }, 403);
    c.set("session", session);
    const data = scoped(c.var.db, session.account.id);
    c.set("data", data);
    // When a session was last used, to the nearest few minutes.
    const now = new Date();
    if (!session.lastUsedAt || now.getTime() - session.lastUsedAt.getTime() > 5 * 60_000) {
      c.executionCtx.waitUntil(data.update("sessions", session.sessionId, { lastUsedAt: now }));
    }
    await next();
  };
}

/** Starts a browser session and returns its token, set once as a cookie. */
export async function startWebSession(db: DrizzleD1Database, accountId: string): Promise<string> {
  const token = randomToken("ocra_web_");
  await scoped(db, accountId).insert("sessions", {
    id: crypto.randomUUID(),
    tokenHash: await sha256Hex(token),
    kind: "web",
    label: null,
    expiresAt: new Date(Date.now() + SESSION_DAYS.web * DAY),
  });
  return token;
}

export type CliTokens = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
};

async function cliTokens(now: number, refreshExpiresAt: number) {
  const access = randomToken("ocra_cli_");
  const refresh = randomToken("ocra_ref_");
  // No access token outlives its session.
  const expiresAt = Math.min(now + CLI_ACCESS_MS, refreshExpiresAt);
  return {
    tokens: {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.floor((expiresAt - now) / 1000),
    } satisfies CliTokens,
    row: {
      tokenHash: await sha256Hex(access),
      expiresAt: new Date(expiresAt),
      refreshHash: await sha256Hex(refresh),
    },
  };
}

/** Starts a CLI session: an access token and a refresh token, shown once. */
export async function startCliSession(
  db: DrizzleD1Database,
  accountId: string,
  label: string | null,
  id: string = crypto.randomUUID(),
): Promise<CliTokens> {
  const now = Date.now();
  const refreshExpiresAt = now + SESSION_DAYS.cli * DAY;
  const { tokens, row } = await cliTokens(now, refreshExpiresAt);
  await scoped(db, accountId).insert("sessions", {
    id,
    kind: "cli",
    label,
    ...row,
    refreshExpiresAt: new Date(refreshExpiresAt),
  });
  return tokens;
}

/**
 * Trades a refresh token for new tokens. The access token it replaces stays
 * valid until its own expiry, for another `ocra` process still using it; the
 * session's 90 days run from sign-in, not from the last refresh. The refresh
 * token it replaces answers once more within REFRESH_GRACE_MS (the response
 * was lost); used later, it ends the session, since someone else holds a copy.
 */
export async function refreshCliSession(
  db: DrizzleD1Database,
  refreshToken: string,
  now = new Date(),
): Promise<CliTokens | undefined> {
  const hash = await sha256Hex(refreshToken);
  const found = await sessionByRefreshHash(db, hash, now);
  if (!found?.refreshHash || !found.refreshExpiresAt) return undefined;
  if (found.refreshHash !== hash) {
    const rotatedAt = found.rotatedAt?.getTime() ?? 0;
    if (now.getTime() - rotatedAt > REFRESH_GRACE_MS) {
      await revokeSession(db, found.sessionId);
      return undefined;
    }
  }
  const { tokens, row } = await cliTokens(now.getTime(), found.refreshExpiresAt.getTime());
  const rotated = await rotateSession(db, found.sessionId, found.refreshHash, {
    ...row,
    prevTokenHash: found.tokenHash,
    prevExpiresAt: found.expiresAt,
    prevRefreshHash: found.refreshHash,
    rotatedAt: now,
  });
  return rotated ? tokens : undefined;
}

/**
 * New tokens for a CLI session started moments ago whose tokens were never
 * used, as when the answer that carried them was lost (audit K-device). The
 * lost pair stops working. Undefined once the session was used or refreshed,
 * or REFRESH_GRACE_MS after it started.
 */
export async function reissueCliSession(
  db: DrizzleD1Database,
  accountId: string,
  sessionId: string,
  now = new Date(),
): Promise<CliTokens | undefined> {
  const s = await scoped(db, accountId).get("sessions", sessionId);
  if (s?.kind !== "cli" || !s.refreshHash || !s.refreshExpiresAt) return undefined;
  if (s.lastUsedAt || s.rotatedAt) return undefined;
  if (now.getTime() - s.createdAt.getTime() > REFRESH_GRACE_MS) return undefined;
  const { tokens, row } = await cliTokens(now.getTime(), s.refreshExpiresAt.getTime());
  return (await rotateSession(db, s.id, s.refreshHash, row)) ? tokens : undefined;
}

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

auth.get("/github/login", async (c) => {
  const state = randomToken("");
  const next = safeNext(c.req.query("next"));
  await setSignedCookie(c, STATE_COOKIE, `${state} ${next}`, c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/auth/github",
    maxAge: 600,
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
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth/github", secure: true });
  const space = cookie ? cookie.indexOf(" ") : -1;
  const expected = cookie && space > 0 ? cookie.slice(0, space) : cookie || undefined;
  const next = cookie && space > 0 ? cookie.slice(space + 1) : undefined;
  const { code, state } = c.req.query();
  if (!code || !state || !expected || state !== expected) {
    return c.json({ error: "bad_state" }, 400);
  }
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(c.req.url),
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !tokenBody.access_token) return c.json({ error: "github_exchange" }, 502);
  // The GitHub token is used once, to learn who signed in, and not kept.
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "ocra-cloud",
    },
  });
  const user = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string };
  if (!userRes.ok || typeof user.id !== "number" || typeof user.login !== "string") {
    return c.json({ error: "github_user" }, 502);
  }
  const account = await upsertAccount(c.var.db, user.id, user.login);
  const token = await startWebSession(c.var.db, account.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS.web * 86_400,
  });
  return c.redirect(safeNext(next), 302);
});

auth.post("/logout", requireSession(["web", "cli"]), async (c) => {
  await c.var.data.remove("sessions", c.var.session.sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});
