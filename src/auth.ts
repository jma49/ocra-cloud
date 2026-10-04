import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "./crypto.js";
import { sessionByTokenHash, upsertAccount } from "./db/accounts.js";
import { scoped } from "./db/scoped.js";
import type { AppEnv } from "./types.js";

export const SESSION_COOKIE = "ocra_session";
const STATE_COOKIE = "ocra_oauth_state";
const DAY = 86_400_000;
export const SESSION_DAYS = { web: 30, cli: 90 } as const;

/**
 * The signed-in account, from the session cookie (the web app) or a bearer
 * token (the CLI). A cookie request that changes something must come from
 * this origin: JSON requests from elsewhere already need a CORS preflight,
 * which this API never grants, and the Origin check covers the rest.
 */
export function requireSession(): MiddlewareHandler<AppEnv> {
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
    c.set("session", session);
    c.set("data", scoped(c.var.db, session.account.id));
    await next();
  };
}

/** Starts a session for an account and returns its token, shown once. */
export async function startSession(
  db: DrizzleD1Database,
  accountId: string,
  kind: "web" | "cli",
  label: string | null,
): Promise<string> {
  const token = randomToken(kind === "cli" ? "ocra_cli_" : "ocra_web_");
  await scoped(db, accountId).insert("sessions", {
    id: crypto.randomUUID(),
    tokenHash: await sha256Hex(token),
    kind,
    label,
    expiresAt: new Date(Date.now() + SESSION_DAYS[kind] * DAY),
  });
  return token;
}

export const auth = new Hono<AppEnv>();

function callbackUrl(requestUrl: string): string {
  return new URL("/api/auth/github/callback", requestUrl).toString();
}

auth.get("/github/login", async (c) => {
  const state = randomToken("");
  await setSignedCookie(c, STATE_COOKIE, state, c.env.SESSION_SECRET, {
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
  const expected = await getSignedCookie(c, c.env.SESSION_SECRET, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth/github", secure: true });
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
  const token = await startSession(c.var.db, account.id, "web", null);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS.web * 86_400,
  });
  return c.redirect("/", 302);
});

auth.post("/logout", requireSession(), async (c) => {
  await c.var.data.remove("sessions", c.var.session.sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});
