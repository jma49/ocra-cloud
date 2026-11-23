import {
  CODEOWNERS_PATHS,
  MAX_CODEOWNERS_BYTES,
  type Owner,
  ownersOfPath,
  parseCodeOwners,
} from "./codeowners.js";
import type { Row, Scoped } from "./db/scoped.js";
import type { CodePlatform } from "./platforms/platform.js";
import { pathPrefixes } from "./review-paths.js";
import { rankReviewers, withLoad } from "./reviewer-rank.js";
import type { SuggestedReviewer } from "./shared/index.js";

// Reviewers suggested for a pull request, as the token reads it: the
// changed files' owners in CODEOWNERS at the base, and who reviewed the
// enrolled repository's pull requests in the last 90 days (pull_reviews),
// more for those changing the directories this one changes (pull_paths).
// The console's suggestions (src/reviewers.ts) read it as the user, an
// assign_reviewers rule as the bot. Nothing read here is stored.

const MAX_SUGGESTIONS = 5;
/** Candidates whose open review requests are read before the last cut. */
const LOAD_POOL = 8;
/** Changed files matched against CODEOWNERS. */
const MAX_FILES = 300;
export const HISTORY_DAYS = 90;
const MAX_HISTORY = 50;
/** Rows of reviewer and changed directory read. */
const MAX_PATH_ROWS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PullSuggestions = {
  author: string | null;
  requested: string[];
  suggestions: SuggestedReviewer[];
  /** The owners of each changed file. */
  perFile: Owner[][];
  codeowners: { path: string; read: boolean } | null;
  enrolled: boolean;
  truncated: boolean;
};

/**
 * The pull request's suggestions; `not_found` when it could not be read,
 * `unreachable` when its CODEOWNERS could not. `enrolled`, when the caller
 * knows it, saves looking the repository up.
 */
export async function suggestReviewers(
  data: Scoped,
  platform: CodePlatform,
  token: string,
  repo: string,
  number: number,
  enrolled?: Row<"reviewRepos">,
): Promise<PullSuggestions | "not_found" | "unreachable"> {
  const [people, changes] = await Promise.all([
    platform.reviewers.people(token, repo, number),
    platform.changes.changes(token, repo, number, MAX_FILES),
  ]);
  if (!people || !changes) return "not_found";
  const repoRef = { platformRepoId: people.platformRepoId, fullName: repo };
  const locations = CODEOWNERS_PATHS[platform.kind];
  const [reads, enrollment] = await Promise.all([
    platform.files.read(token, repoRef, people.base, [...locations], MAX_CODEOWNERS_BYTES),
    enrolled ??
      data.findOne("reviewRepos", {
        platform: platform.kind,
        host: platform.host,
        platformRepoId: people.platformRepoId,
      }),
  ]);
  if (!reads) return "unreachable";
  const found = reads.find((r) => r.blobId !== null);
  const file = found?.bytes
    ? parseCodeOwners(new TextDecoder().decode(found.bytes), platform.kind)
    : null;
  const perFile = file ? changes.files.map((f) => ownersOfPath(file, f.path)) : [];
  const since = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
  const prefixes = pathPrefixes(changes.files.flatMap((f) => [f.path, f.oldPath]));
  const [history, paths] = enrollment
    ? await Promise.all([
        data.pullFlows.reviewersSince(since, [enrollment.id], MAX_HISTORY),
        data.pullPaths.reviewersIn(since, enrollment.id, prefixes, MAX_PATH_ROWS),
      ])
    : [[], []];
  const pool = rankReviewers({
    author: people.author,
    requested: people.requested,
    owners: perFile,
    history,
    paths,
  }).slice(0, LOAD_POOL);
  const load = await platform.reviewers.load(
    token,
    pool.map((p) => p.login),
  );
  return {
    author: people.author,
    requested: people.requested,
    suggestions: withLoad(pool, load).slice(0, MAX_SUGGESTIONS),
    perFile,
    codeowners: found ? { path: found.path, read: file !== null } : null,
    enrolled: enrollment !== undefined,
    truncated: changes.truncated,
  };
}
