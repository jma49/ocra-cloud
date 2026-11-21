import { Hono } from "hono";
import { githubIdentity, upsertAccount } from "./db/accounts.js";
import { scoped } from "./db/scoped.js";
import { deadline } from "./deadline.js";
import { apiError } from "./http.js";
import { oidcClientOf } from "./oidc.js";
import { github } from "./platforms/github.js";
import { saveToken } from "./platforms/links.js";
import type { TokenAnswer } from "./platforms/platform.js";
import { githubClientOf } from "./platforms/registry.js";
import { clearSessionCookie, requireSession, signInBrowser } from "./session.js";
import type { SignInMethod } from "./shared/index.js";
import { finishSignIn, startSignIn } from "./sign-in-state.js";
import type { AppEnv } from "./types.js";

// Signing in with GitHub, and signing out. ./oidc.ts signs in through an
// OpenID Connect provider instead.

export const auth = new Hono<AppEnv>();

/** How this deployment signs people in, for the sign-in page. */
auth.get("/methods", (c) => {
  const methods: SignInMethod[] = [];
  if (githubClientOf(c.env)) methods.push({ id: "github", name: "GitHub" });
  const oidc = oidcClientOf(c.env);
  if (oidc) methods.push({ id: "oidc", name: oidc.name });
  return c.json({ methods });
});

function callbackUrl(requestUrl: string): string {
  return new URL("/api/auth/github/callback", requestUrl).toString();
}

/** How long each GitHub call at sign-in may take, its answer read (audit C5). */
const GITHUB_TIMEOUT_MS = 10_000;

/** A GitHub call's JSON answer; null when it failed, was refused or took too long. */
async function githubCall<T>(url: string, init: RequestInit): Promise<T | null> {
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
  const client = githubClientOf(c.env);
  if (!client) return apiError(c, "not_found");
  const state = await startSignIn(c);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return c.redirect(url.toString(), 302);
});

auth.get("/github/callback", async (c) => {
  const client = githubClientOf(c.env);
  if (!client) return apiError(c, "not_found");
  const signIn = await finishSignIn(c);
  const code = c.req.query("code");
  if (!signIn || !code) return apiError(c, "bad_state");
  const tokenBody = await githubCall<TokenAnswer>("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: client.id,
      client_secret: client.secret,
      code,
      redirect_uri: callbackUrl(c.req.url),
    }),
  });
  if (!tokenBody?.access_token) return apiError(c, "github_exchange");
  // The GitHub token tells who signed in, and is kept below.
  const user = await githubCall<{ id?: number; login?: string }>("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "ocra-cloud",
    },
  });
  if (typeof user?.id !== "number" || typeof user.login !== "string") {
    return apiError(c, "github_user");
  }
  const account = await upsertAccount(c.var.db, githubIdentity(user.id), user.login);
  // Kept so the console can read what the user reaches on GitHub
  // (./platforms/links.ts).
  await saveToken(scoped(c.var.db, account.id), c.env, github(client), tokenBody);
  await signInBrowser(c, account.id);
  return c.redirect(signIn.next, 302);
});

auth.post("/logout", requireSession(["web", "cli"]), async (c) => {
  await c.var.data.remove("sessions", c.var.session.sessionId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
