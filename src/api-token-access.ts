import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import { audit } from "./audit.js";
import { sameText, sha256Hex } from "./crypto.js";
import { apiTokenByHash } from "./db/api-tokens.js";
import { scoped } from "./db/scoped.js";
import { defer } from "./defer.js";
import { apiError } from "./http.js";
import { API_TOKEN_PREFIX, API_TOKEN_ROUTES, type ApiTokenScope } from "./shared/index.js";
import { MINUTE } from "./time.js";
import type { AppEnv } from "./types.js";

/** A token's last use is written at most this often. */
const API_TOKEN_TOUCH_MS = MINUTE;

export const isApiToken = (bearer: string) => bearer.startsWith(API_TOKEN_PREFIX);

/**
 * The scope a token needs for this request, from API_TOKEN_ROUTES by the
 * route the request matched; undefined (refused) for any route not listed
 * and for any method but GET. The middleware's own path is the handler's
 * only when it sits on the route itself, not on a router's `use`.
 */
function scopeFor(c: Context<AppEnv>): ApiTokenScope | undefined {
  if (c.req.method !== "GET") return undefined;
  const path = routePath(c);
  if (path !== routePath(c, -1)) return undefined;
  return Object.hasOwn(API_TOKEN_ROUTES, `GET ${path}`)
    ? API_TOKEN_ROUTES[`GET ${path}`]
    : undefined;
}

async function allowed(c: Context<AppEnv>, ...keys: string[]) {
  for (const key of keys) {
    if (!(await c.env.ACCOUNT_CALLS.limit({ key })).success) return false;
  }
  return true;
}

/**
 * requireSession's way for a personal API token: an unexpired token of
 * that hash (401 otherwise), a route its scopes reach (403 otherwise), and
 * the token's allowance per minute and the account's for all its tokens
 * together (429), so that more tokens buy no more calls. Its use is
 * written at most every API_TOKEN_TOUCH_MS, and its first use is audited
 * once.
 */
export async function tokenAccess(c: Context<AppEnv>, next: Next, secret: string) {
  const now = new Date();
  const hash = await sha256Hex(secret);
  const token = await apiTokenByHash(c.var.db, hash, now);
  // The row was found by its hash; comparing again in constant time keeps a
  // lookup that matched loosely (a collation, a prefix index) from letting
  // a different secret in.
  if (!token || !sameText(token.tokenHash, hash)) return apiError(c, "unauthenticated");
  const scope = scopeFor(c);
  if (!scope || !token.scopes.includes(scope)) {
    return apiError(c, "forbidden_for_session", scope ? { scope } : {});
  }
  if (!(await allowed(c, `token:${token.id}`, `token-account:${token.account.id}`))) {
    c.header("retry-after", "60");
    return apiError(c, "slow_down", {}, 429);
  }
  c.set("session", {
    account: token.account,
    sessionId: token.id,
    kind: "token",
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
  });
  const data = scoped(c.var.db, token.account.id);
  c.set("data", data);
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() > API_TOKEN_TOUCH_MS) {
    defer(
      c,
      data.apiTokens.touch(token.id, now, API_TOKEN_TOUCH_MS).then(async (first) => {
        if (first) await audit(data, "token.first_used", { prefix: token.prefix });
      }),
    );
  }
  await next();
}
