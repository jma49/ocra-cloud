import type { Context } from "hono";
import { type Account, githubIdOf, recordSignInCheck, recordSignInTry } from "./db/accounts.js";
import { scoped } from "./db/scoped.js";
import { apiError } from "./http.js";
import { github } from "./platforms/github.js";
import { accessToken } from "./platforms/links.js";
import { githubClientOf, githubHostOf } from "./platforms/registry.js";
import { SIGN_IN_NOT_ALLOWED } from "./shared/index.js";
import { type AllowList, allowListOf, anyIn, emailDomainOf } from "./sign-in-allow.js";
import { githubAllowed } from "./sign-in-github.js";
import { HOUR, MINUTE } from "./time.js";
import type { AppEnv } from "./types.js";

// SIGN_IN_ALLOW at sign-in and after: a sign-in that matches no entry is
// refused before any account is made, and an account's sessions and API
// tokens are refused once it no longer matches. Asking GitHub on every
// request would cost calls per request, so an account's answer is kept in
// its row and asked again at most every RECHECK_MS, or at once when the
// list changes.

/** How long an account's answer stands before GitHub is asked again. */
const RECHECK_MS = HOUR;
/** How long after GitHub could not answer it is not asked again. */
const RETRY_MS = 5 * MINUTE;
/** How long a match stands while GitHub cannot answer. */
const UNSURE_GRACE_MS = 24 * HOUR;

/** The deployment's allowlist; undefined when anyone may sign in. */
export const allowListFor = (c: Context<AppEnv>) => allowListOf(c.env.SIGN_IN_ALLOW);

export const signInRefused = (c: Context<AppEnv>) =>
  apiError(c, "forbidden_for_session", { reason: SIGN_IN_NOT_ALLOWED });

const sessionRefused = (c: Context<AppEnv>) =>
  apiError(c, "unauthenticated", { reason: SIGN_IN_NOT_ALLOWED });

type OidcClaims = { email?: unknown; email_verified?: unknown; groups?: unknown };

/**
 * Whether an OpenID Connect user matches: a verified email's domain, or a
 * group of the userinfo's `groups` claim (compared exactly). `org:` and
 * `user:` name GitHub accounts and never match here.
 */
export function oidcAllowed(list: AllowList, claims: OidcClaims): boolean {
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const domain = verified ? emailDomainOf(claims.email) : undefined;
  if (domain && anyIn(list.domains, [domain])) return true;
  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === "string")
    : [];
  return anyIn(list.groups, groups);
}

/** Records an answer reached at sign-in, so the account's sessions start out checked. */
export const recordAdmission = (c: Context<AppEnv>, accountId: string, list: AllowList) =>
  recordSignInCheck(c.var.db, accountId, { key: list.key, allowed: true, at: new Date() });

/** The account's answer asked again: GitHub live, OpenID Connect from its sign-in. */
async function askAgain(c: Context<AppEnv>, account: Account, list: AllowList) {
  const githubId = await githubIdOf(c.var.db, account.id);
  if (githubId === null) {
    // Nothing to ask an OpenID Connect provider without the person: the
    // answer of their sign-in stands while the list is the same one.
    return account.signInAllowKey === list.key && account.signInAllowed === true;
  }
  const client = githubClientOf(c.env);
  const token = client
    ? await accessToken(scoped(c.var.db, account.id), c.env, github(client))
    : null;
  return githubAllowed(list, {
    api: githubHostOf(c.env).api,
    token,
    login: account.login,
    bots: c.var.bots,
  });
}

/**
 * A refusal when SIGN_IN_ALLOW is set and the account no longer matches it;
 * undefined to let the request on. An answer GitHub cannot give (it is
 * unreachable, or the account's token is gone and no App can read the
 * organisation) keeps a match found within UNSURE_GRACE_MS, and refuses
 * after; GitHub is then not asked again for RETRY_MS.
 */
export async function checkAccount(
  c: Context<AppEnv>,
  account: Account,
): Promise<Response | undefined> {
  const list = await allowListFor(c);
  if (!list) return undefined;
  const now = Date.now();
  const checkedAt = account.signInCheckedAt?.getTime() ?? 0;
  const sameList = account.signInAllowKey === list.key;
  if (sameList && now - checkedAt < RECHECK_MS) {
    return account.signInAllowed ? undefined : sessionRefused(c);
  }
  // A match found lately stands while GitHub cannot answer, and refuses after.
  const unsure = () => {
    const lately = sameList && account.signInAllowed && now - checkedAt < UNSURE_GRACE_MS;
    return lately ? undefined : sessionRefused(c);
  };
  const triedAt = account.signInTriedAt?.getTime() ?? 0;
  if (now - triedAt < RETRY_MS) return unsure();
  const verdict = await askAgain(c, account, list);
  if (verdict === undefined) {
    await recordSignInTry(c.var.db, account.id, new Date(now));
    return unsure();
  }
  await recordSignInCheck(c.var.db, account.id, {
    key: list.key,
    allowed: verdict,
    at: new Date(now),
  });
  return verdict ? undefined : sessionRefused(c);
}
