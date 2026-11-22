import type { PathReader } from "../auto-review/paths.js";
import type { Row } from "../db/scoped.js";
import { scoped } from "../db/scoped.js";
import { gitlabDiscussionStart } from "../platforms/gitlab-discussion.js";
import { accessToken } from "../platforms/links.js";
import type { StartOf } from "./thread-hooks.js";

// A GitLab note hook says which discussion a note is in, not whether it is
// the first: for a discussion not on record, its first note is read once,
// as the bot or else the enrolling account's link, after the hook is
// answered. No token, a refusal or a timeout keeps nothing.

export function gitlabStartOf(
  reader: PathReader,
  repo: Pick<Row<"reviewRepos">, "accountId" | "platform" | "host" | "fullName">,
): StartOf {
  return async (number, threadKey) => {
    const platform = reader.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
    if (!platform) return null;
    const bot = reader.bots ? await reader.bots.forRepo(repo.platform, repo.fullName) : null;
    const token =
      bot?.token ?? (await accessToken(scoped(reader.db, repo.accountId), reader.env, platform));
    if (!token) return null;
    return gitlabDiscussionStart(platform.url, token, repo.fullName, number, threadKey);
  };
}
