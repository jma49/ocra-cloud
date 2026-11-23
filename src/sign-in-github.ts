import { deadline } from "./deadline.js";
import type { BotTokens } from "./platforms/bot.js";
import { type AllowList, anyIn, emailDomainOf } from "./sign-in-allow.js";

// Whether a GitHub user matches SIGN_IN_ALLOW, read live from GitHub: their
// login, their organisation memberships (with their own token, else the
// App's Members read), and their verified email addresses.

/** true or false; undefined when GitHub could not tell (unreachable, or no credential). */
export type Verdict = boolean | undefined;

const TIMEOUT_MS = 10_000;

type Answer = { status: number; body: unknown };

/** A GET's status and JSON; null when it did not answer in time. Never followed. */
async function get(url: string, token: string): Promise<Answer | null> {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: clock.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "ocra-cloud",
      },
    });
    const body = res.ok && res.status !== 204 ? await res.json().catch(() => null) : null;
    if (!res.ok || res.status === 204) await res.body?.cancel().catch(() => {});
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}

export type GithubPerson = {
  api: string;
  /** The user's own token: at sign-in, or the one kept for the account. */
  token: string | null;
  /** The login to use when there is no token to read it with, or when it is `fresh`. */
  login: string;
  /** The login was just read with the token (at sign-in), so it is not read again. */
  fresh?: boolean;
  bots?: BotTokens | undefined;
};

/** Organisations asked at once: a list holds up to 50 entries. */
const ORG_CONCURRENCY = 4;

/**
 * The person as checked: the login read with their token, or, when GitHub
 * refuses the token (revoked), the stored login and no token, so the App's
 * read stands in. Undefined when GitHub did not answer.
 */
async function current(
  p: GithubPerson,
): Promise<{ person: GithubPerson; login: string } | undefined> {
  if (!p.token || p.fresh) return { person: p, login: p.login.toLowerCase() };
  const user = await get(`${p.api}/user`, p.token);
  if (user?.status === 401) return { person: { ...p, token: null }, login: p.login.toLowerCase() };
  const login = (user?.body as { login?: unknown } | null)?.login;
  if (user?.status !== 200 || typeof login !== "string") return undefined;
  return { person: p, login: login.toLowerCase() };
}

async function orgMember(p: GithubPerson, org: string, login: string): Promise<Verdict> {
  if (p.token) {
    const res = await get(`${p.api}/user/memberships/orgs/${encodeURIComponent(org)}`, p.token);
    if (res?.status === 200) return (res.body as { state?: unknown } | null)?.state === "active";
    if (res?.status === 404) return false;
  }
  // No token, or one that may not read the organisation: the App's own read.
  const app = await p.bots?.orgMember?.(org, login);
  return app ?? undefined;
}

async function verifiedDomains(p: GithubPerson): Promise<string[] | undefined> {
  if (!p.token) return undefined;
  const res = await get(`${p.api}/user/emails?per_page=100`, p.token);
  if (res?.status !== 200 || !Array.isArray(res.body)) return undefined;
  return res.body.flatMap((e: { email?: unknown; verified?: unknown }) => {
    const domain = e?.verified === true ? emailDomainOf(e.email) : undefined;
    return domain ? [domain] : [];
  });
}

/**
 * Whether the GitHub user matches `list`: its first matching entry answers
 * true; false when every entry was read and none matched; undefined when
 * none matched but one could not be read.
 */
export async function githubAllowed(list: AllowList, asked: GithubPerson): Promise<Verdict> {
  const found = await current(asked);
  if (!found) return undefined;
  const { person: p, login } = found;
  if (anyIn(list.users, [login])) return true;
  let unsure = false;
  if (list.domains.length > 0) {
    const domains = await verifiedDomains(p);
    if (domains && anyIn(list.domains, domains)) return true;
    if (!domains) unsure = true;
  }
  for (let i = 0; i < list.orgs.length; i += ORG_CONCURRENCY) {
    const part = list.orgs.slice(i, i + ORG_CONCURRENCY);
    const members = await Promise.all(part.map((org) => orgMember(p, org, login)));
    if (members.includes(true)) return true;
    if (members.includes(undefined)) unsure = true;
  }
  return unsure ? undefined : false;
}
