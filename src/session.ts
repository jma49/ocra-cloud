import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "./crypto.js";
import {
  revokeSession,
  revokeWebSession,
  rotateSession,
  sessionByRefreshHash,
  sessionByTokenHash,
} from "./db/accounts.js";
import type { Db } from "./db/client.js";
import { scoped } from "./db/scoped.js";
import { defer } from "./defer.js";
import { apiError } from "./http.js";
import { RECENT_SIGN_IN, RECENT_SIGN_IN_MINUTES } from "./shared/index.js";
import { DAY, HOUR, MINUTE } from "./time.js";
import type { AppEnv } from "./types.js";

// Sessions: the guard every signed-in route sits behind, the session cookie,
// and starting, refreshing and reissuing web and CLI sessions.

/**
 * `__Host-`: the browser takes it only with Secure, Path=/ and no Domain, so
 * a sibling subdomain cannot plant a session (login CSRF). Renamed from
 * `ocra_session`, which signed browsers out once (#15).
 */
const SESSION_COOKIE = "__Host-ocra_session";
const SESSION_DAYS = { web: 30, cli: 90 } as const;
/** A browser session unused this long has ended, within its SESSION_DAYS.web (audit C7). */
const WEB_IDLE_MS = 7 * DAY;
/** A CLI access token lives an hour; its refresh token, SESSION_DAYS.cli. */
const CLI_ACCESS_MS = HOUR;
/** How long a refresh token used once still answers, for a response that was lost. */
export const REFRESH_GRACE_MS = MINUTE;
/** A session's last use is written at most this often. */
const LAST_USED_EVERY_MS = 5 * MINUTE;

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
    if (!token) return apiError(c, "unauthenticated");
    if (!bearer && !["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== new URL(c.req.url).origin) return apiError(c, "bad_origin");
    }
    const now = new Date();
    const session = await sessionByTokenHash(c.var.db, await sha256Hex(token), now);
    if (!session) return apiError(c, "unauthenticated");
    if (session.kind === "web" && webSessionEnd(session) <= now) {
      return apiError(c, "unauthenticated");
    }
    // A CLI token reaches only what the CLI needs (ADR-0024): never keys,
    // sessions or the account.
    if (!kinds.includes(session.kind)) return apiError(c, "forbidden_for_session");
    c.set("session", session);
    const data = scoped(c.var.db, session.account.id);
    c.set("data", data);
    // When a session was last used, to the nearest few minutes.
    if (!session.lastUsedAt || now.getTime() - session.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
      defer(c, data.update("sessions", session.sessionId, { lastUsedAt: now }));
    }
    await next();
  };
}

/**
 * When a browser session ends: SESSION_DAYS.web after its sign-in, or
 * WEB_IDLE_MS after its last use (its sign-in if never used), whichever
 * comes first. Its last use is written at most every LAST_USED_EVERY_MS.
 */
export function webSessionEnd(s: {
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}): Date {
  const used = (s.lastUsedAt ?? s.createdAt).getTime();
  return new Date(Math.min(s.expiresAt.getTime(), used + WEB_IDLE_MS));
}

/**
 * A refusal unless the request's session signed in within
 * RECENT_SIGN_IN_MINUTES: for a change a stolen or forgotten session must
 * not make (audit C7). Web sessions only; the CLI never reaches these.
 */
export function needsRecentSignIn(c: Context<AppEnv>): Response | undefined {
  const age = Date.now() - c.var.session.createdAt.getTime();
  if (age <= RECENT_SIGN_IN_MINUTES * MINUTE) return undefined;
  return apiError(c, "forbidden_for_session", { reason: RECENT_SIGN_IN });
}

/**
 * Signs this browser in: a new session in its cookie. The session the cookie
 * held before ends now, not at its idle or 30-day end, since nothing in this
 * browser can reach it again (#92).
 */
export async function signInBrowser(c: Context<AppEnv>, accountId: string): Promise<void> {
  const replaced = getCookie(c, SESSION_COOKIE);
  if (replaced) await revokeWebSession(c.var.db, await sha256Hex(replaced));
  setSessionCookie(c, await startWebSession(c.var.db, accountId));
}

/** Starts a browser session and returns its token, set once as a cookie. */
export async function startWebSession(db: Db, accountId: string): Promise<string> {
  const token = randomToken("ocra_web_");
  await scoped(db, accountId).insert("sessions", {
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
  db: Db,
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
  db: Db,
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
  db: Db,
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

/** Sets the web session cookie, as sign-in leaves it. */
function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS.web * 86_400,
  });
}

/** Clears the web session cookie (sign-out, a revoked current session, a deleted account). */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}
