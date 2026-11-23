import { outboundFetch } from "../calls.js";
import { decryptWithAny, encryptSecret, type MasterKeys, type Sealed } from "../crypto.js";
import type { BotRepo } from "./bot.js";
import { isBotLogin, LOGIN } from "./reviewers.js";

// An enrolled GitLab project's own access token: a project or group access
// token, for which GitLab made a bot user. Sealed like a model key and bound
// to the account and the repository's row, so it opens for no other row.
// Never logged, never answered, never exported.

/** The columns of an enrolled repository that carry its own token, for callers that pick columns. */
export type RepoTokenFields = "id" | "accessTokenWrappedKey" | "accessTokenCiphertext";

const binding = (accountId: string, repoId: string) => `ocra-repo-token:v1|${accountId}|${repoId}`;

export function sealRepoToken(
  masterKey: string,
  repo: { accountId: string; id: string },
  token: string,
): Promise<Sealed> {
  return encryptSecret(masterKey, token, binding(repo.accountId, repo.id));
}

/** The repository's own token; null without one, or when it no longer opens. */
export async function openRepoToken(keys: MasterKeys, repo: BotRepo): Promise<string | null> {
  const { id, accountId } = repo;
  const wrappedKey = repo.accessTokenWrappedKey;
  const ciphertext = repo.accessTokenCiphertext;
  if (!id || !accountId || !wrappedKey || !ciphertext) return null;
  try {
    return await decryptWithAny(keys, { wrappedKey, ciphertext }, binding(accountId, id));
  } catch {
    return null;
  }
}

/** Whether the repository has a token of its own, opened or not. */
export const hasRepoToken = (repo: BotRepo) =>
  !!repo.accessTokenWrappedKey && !!repo.accessTokenCiphertext;

/** Developer: the least role that may push a branch and comment on merge requests. */
const DEVELOPER = 30;

export type TokenCheck =
  | { ok: true; bot: string }
  | { ok: false; reason: "rejected" | "person" | "role" | "scope" | "unreachable" };

type Answer = { status: number; body: unknown };

/** A GitLab call's status, and its JSON when it succeeded; null when it failed or took too long. */
async function call(url: string, token: string): Promise<Answer | null> {
  try {
    const res = await outboundFetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null };
    }
    return { status: res.status, body: await res.json() };
  } catch {
    return null;
  }
}

const refused = (a: Answer) => a.status === 401 || a.status === 403;

/**
 * Whether the token may post ocra's reviews on the project: GitLab takes
 * it, it is a bot user's (a project or group access token, never a
 * person's), with scope api and at least the Developer role there.
 */
export async function checkGitlabAccessToken(
  url: string,
  token: string,
  projectId: string,
): Promise<TokenCheck> {
  const api = `${url}/api/v4`;
  const user = await call(`${api}/user`, token);
  if (!user) return { ok: false, reason: "unreachable" };
  if (refused(user)) return { ok: false, reason: "rejected" };
  const u = user.body as { id?: unknown; username?: unknown; bot?: unknown } | null;
  if (!u || typeof u.id !== "number" || !Number.isSafeInteger(u.id)) {
    return { ok: false, reason: "unreachable" };
  }
  const login = typeof u.username === "string" ? u.username : "";
  if (u.bot !== true || !LOGIN.test(login) || !isBotLogin(login)) {
    return { ok: false, reason: "person" };
  }
  const [self, member] = await Promise.all([
    call(`${api}/personal_access_tokens/self`, token),
    call(`${api}/projects/${encodeURIComponent(projectId)}/members/all/${u.id}`, token),
  ]);
  if (!self || !member) return { ok: false, reason: "unreachable" };
  const scopes = (self.body as { scopes?: unknown } | null)?.scopes;
  if (!Array.isArray(scopes) || !scopes.includes("api")) return { ok: false, reason: "scope" };
  const level = (member.body as { access_level?: unknown } | null)?.access_level;
  if (typeof level !== "number" || level < DEVELOPER) return { ok: false, reason: "role" };
  return { ok: true, bot: login };
}

/** Whether GitLab answers the token with 401: revoked or expired. False when it cannot tell. */
export async function gitlabTokenRejected(url: string, token: string): Promise<boolean> {
  return (await call(`${url}/api/v4/user`, token))?.status === 401;
}
