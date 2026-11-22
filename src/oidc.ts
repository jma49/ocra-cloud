import { Hono } from "hono";
import { pkceChallenge, randomToken } from "./crypto.js";
import { upsertAccount } from "./db/accounts.js";
import { scoped } from "./db/scoped.js";
import { apiError } from "./http.js";
import { gitlab } from "./platforms/gitlab.js";
import { platformCall } from "./platforms/http.js";
import { saveToken } from "./platforms/links.js";
import type { TokenAnswer } from "./platforms/platform.js";
import { gitlabCallback, gitlabClientOf } from "./platforms/registry.js";
import { signInBrowser } from "./session.js";
import { finishSignIn, startSignIn } from "./sign-in-state.js";
import type { AppBindings, AppEnv } from "./types.js";

// Signing in through an OpenID Connect provider: a company's SSO, or a
// self-hosted GitLab, which is one. Authorization code with PKCE; who signed
// in is read from the userinfo endpoint over TLS, so no ID token is parsed.

type OidcClient = { issuer: string; id: string; secret: string; name: string };

/** This deployment's OpenID Connect client, when it has one. */
export function oidcClientOf(env: AppBindings): OidcClient | undefined {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return undefined;
  return {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
    id: env.OIDC_CLIENT_ID,
    secret: env.OIDC_CLIENT_SECRET,
    name: env.OIDC_NAME || "SSO",
  };
}

type Endpoints = { authorize: string; token: string; userinfo: string };

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discovered = new Map<string, { endpoints: Endpoints; until: number }>();

/**
 * The provider's endpoints from its discovery document, which must name the
 * configured issuer itself and keep every endpoint on the issuer's scheme.
 */
async function endpointsOf(issuer: string): Promise<Endpoints | undefined> {
  const cached = discovered.get(issuer);
  if (cached && cached.until > Date.now()) return cached.endpoints;
  const doc = await platformCall<Record<string, unknown>>(
    `${issuer}/.well-known/openid-configuration`,
    { headers: { accept: "application/json" } },
  );
  if (!doc || String(doc.issuer).replace(/\/+$/, "") !== issuer) return undefined;
  const scheme = new URL(issuer).protocol;
  const endpoint = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    try {
      return new URL(value).protocol === scheme ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const authorize = endpoint(doc.authorization_endpoint);
  const token = endpoint(doc.token_endpoint);
  const userinfo = endpoint(doc.userinfo_endpoint);
  if (!authorize || !token || !userinfo) return undefined;
  const endpoints = { authorize, token, userinfo };
  discovered.set(issuer, { endpoints, until: Date.now() + DISCOVERY_TTL_MS });
  return endpoints;
}

/**
 * The deployment's GitLab, when people sign in with the same application
 * of it that connects GitLab: then one consent does both, and the sign-in's
 * token, with the api scope, is kept as the person's GitLab link.
 */
function gitlabSignIn(env: AppBindings, client: OidcClient) {
  const lab = gitlabClientOf(env);
  return lab && lab.id === client.id && lab.url === client.issuer ? lab : undefined;
}

/** Forgets the discovered endpoints (for tests). */
export function forgetDiscovery(): void {
  discovered.clear();
}

const callbackUrl = (requestUrl: string) =>
  new URL("/api/auth/oidc/callback", requestUrl).toString();

type UserInfo = { sub?: unknown; preferred_username?: unknown; email?: unknown; name?: unknown };

/** The name the console shows: the provider's username, else the email, else the subject. */
function loginOf(info: UserInfo, subject: string): string {
  for (const value of [info.preferred_username, info.email, info.name]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 100);
  }
  return subject.slice(0, 100);
}

export const oidc = new Hono<AppEnv>();

oidc.get("/login", async (c) => {
  const client = oidcClientOf(c.env);
  if (!client) return apiError(c, "not_found");
  const endpoints = await endpointsOf(client.issuer);
  if (!endpoints) return apiError(c, "upstream_unreachable");
  const verifier = randomToken("");
  const state = await startSignIn(c, { verifier });
  const url = new URL(endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  const scope = gitlabSignIn(c.env, client) ? "openid profile email api" : "openid profile email";
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return c.redirect(url.toString(), 302);
});

oidc.get("/callback", async (c) => {
  const client = oidcClientOf(c.env);
  if (!client) return apiError(c, "not_found");
  const signIn = await finishSignIn(c);
  const code = c.req.query("code");
  if (!signIn?.verifier || !code) return apiError(c, "bad_state");
  const endpoints = await endpointsOf(client.issuer);
  if (!endpoints) return apiError(c, "upstream_unreachable");
  const token = await platformCall<TokenAnswer>(endpoints.token, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(c.req.url),
      code_verifier: signIn.verifier,
    }),
  });
  if (typeof token?.access_token !== "string") return apiError(c, "upstream_unreachable");
  const info = await platformCall<UserInfo>(endpoints.userinfo, {
    headers: { accept: "application/json", authorization: `Bearer ${token.access_token}` },
  });
  if (typeof info?.sub !== "string" || !info.sub) return apiError(c, "upstream_unreachable");
  const account = await upsertAccount(
    c.var.db,
    { provider: "oidc", subject: info.sub },
    loginOf(info, info.sub),
  );
  const lab = gitlabSignIn(c.env, client);
  if (lab) {
    const platform = gitlab(lab, gitlabCallback(c.req.url));
    await saveToken(scoped(c.var.db, account.id), c.env, platform, token);
  }
  await signInBrowser(c, account.id, "oidc");
  return c.redirect(signIn.next, 302);
});
