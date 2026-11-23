import type { Db } from "../db/client.js";
import type { Row } from "../db/scoped.js";
import { scoped } from "../db/scoped.js";
import type { BotTokens } from "../platforms/bot.js";
import { COMMIT_ID } from "../platforms/contents.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import { pathPrefixes } from "../review-paths.js";
import type { AppBindings } from "../types.js";

// After a review of an enrolled repository's pull request is kept, the
// directories it changes are read once per head, as the bot or else the
// account's link, at most MAX_PATH_FILES files, so suggested reviewers can
// say who reviewed changes to the same directories (src/reviewers.ts).

/** Changed files read per reviewed pull request. */
const MAX_PATH_FILES = 300;

/** The pull request a review was kept on, at the head the event names. */
export type ReviewedPull = { repo: Row<"reviewRepos">; number: number; head: string | undefined };

export type PathReader = {
  db: Db;
  bots: BotTokens | undefined;
  platforms: readonly CodePlatform[];
  env: Pick<AppBindings, "MASTER_KEY" | "MASTER_KEY_PREVIOUS">;
};

export async function keepReviewedPaths(
  reader: PathReader,
  reviewed: ReviewedPull,
  now = new Date(),
): Promise<boolean> {
  const { repo, number, head } = reviewed;
  if (!head || !COMMIT_ID.test(head)) return false;
  const data = scoped(reader.db, repo.accountId);
  if ((await data.pullPaths.headOf(repo.id, number)) === head) return false;
  const platform = reader.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) return false;
  const bot = reader.bots ? await reader.bots.forRepo(repo) : null;
  const token = bot?.token ?? (await accessToken(data, reader.env, platform));
  if (!token) return false;
  const listed = await platform.changes.changes(token, repo.fullName, number, MAX_PATH_FILES);
  if (!listed) return false;
  const prefixes = pathPrefixes(listed.files.flatMap((f) => [f.path, f.oldPath]));
  await data.pullPaths.keep(repo.id, number, listed.head, prefixes, now);
  return true;
}
