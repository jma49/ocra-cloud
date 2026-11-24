import type { PathReader } from "../auto-review/paths.js";
import type { Row } from "../db/scoped.js";
import { scoped } from "../db/scoped.js";
import { gitlabDiscussionStart } from "../platforms/gitlab-discussion.js";
import { accessToken } from "../platforms/links.js";
import type { Reactions } from "../platforms/reactions.js";
import type { RepoTokenFields } from "../platforms/repo-token.js";
import type { StartOf } from "./thread-hooks.js";

// A GitLab note hook says which discussion a note is in, not whether it is
// the first: for a discussion not on record, its first note is read once,
// as the bot or else the enrolling account's link, after the hook is
// answered; so are the reactions on a finding's note when a person writes
// in its discussion. No token, a refusal or a timeout keeps nothing.

type HookRepo = Pick<Row<"reviewRepos">, "accountId" | "platform" | "host" | "fullName"> &
  Partial<Pick<Row<"reviewRepos">, RepoTokenFields>>;

/** The repository's platform and a token for it: the bot's, else the enrolling account's link. */
async function reach(reader: PathReader, repo: HookRepo) {
  const platform = reader.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) return null;
  const bot = reader.bots ? await reader.bots.forRepo(repo) : null;
  const token =
    bot?.token ?? (await accessToken(scoped(reader.db, repo.accountId), reader.env, platform));
  return token ? { platform, token } : null;
}

export function gitlabStartOf(reader: PathReader, repo: HookRepo): StartOf {
  return async (number, threadKey) => {
    const reached = await reach(reader, repo);
    if (!reached) return null;
    return gitlabDiscussionStart(
      reached.platform.url,
      reached.token,
      repo.fullName,
      number,
      threadKey,
    );
  };
}

/** The 👍 and 👎 on a merge request's note, read as the discussion's start is. */
export function gitlabReactionsOf(reader: PathReader, repo: HookRepo) {
  return async (number: number, noteId: string): Promise<Reactions | null> => {
    const reached = await reach(reader, repo);
    if (!reached) return null;
    const read = await reached.platform.reactions.read(reached.token, repo.fullName, number, [
      noteId,
    ]);
    return read instanceof Map ? (read.get(noteId) ?? null) : null;
  };
}
