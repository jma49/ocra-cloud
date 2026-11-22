import type { SeenPull } from "./db/pull-seen.js";
import type { Scoped } from "./db/scoped.js";
import type { PullPatches } from "./platforms/changes.js";
import type { CodePlatform } from "./platforms/platform.js";
import type { PullActionOutcome, PullViewedRequest } from "./shared/index.js";

// Which files of a pull request the user ticked as viewed. GitHub keeps
// the tick itself; for GitLab, which has no API for it, the console keeps
// it with the file's version then, and a tick counts only while the file's
// version at the current head is the same.

type Pull = { repo: string; number: number };

const keyOf = (platform: CodePlatform, pull: Pull): SeenPull => ({
  platform: platform.kind,
  repo: pull.repo.toLowerCase(),
  number: pull.number,
});

/** Whether each listed file is viewed, by path: missing where the platform did not say. */
export async function viewedOf(
  data: Scoped,
  platform: CodePlatform,
  pull: Pull,
  patches: PullPatches,
  kept: Map<string, boolean> | null,
): Promise<Map<string, boolean>> {
  if (platform.viewed) return kept ?? new Map();
  const versions = await data.pullFileViews.versions(keyOf(platform, pull));
  return new Map(
    patches.files.map((f) => [f.path, f.version !== null && versions.get(f.path) === f.version]),
  );
}

/**
 * Ticks or unticks the files while the pull request is at the head the
 * page read; a path that is not one of its files is refused unsent.
 */
export async function markViewed(
  data: Scoped,
  platform: CodePlatform,
  token: string,
  request: PullViewedRequest,
): Promise<PullActionOutcome | null> {
  const paths = [...new Set(request.paths)];
  const { repo, number, head, viewed } = request;
  if (platform.viewed) return platform.viewed.mark(token, repo, number, { head, paths, viewed });
  const patches = await platform.changes.patches(token, repo, number);
  if (!patches) return null;
  if (patches.head !== head) return "head_moved";
  const listed = new Map(patches.files.map((f) => [f.path, f.version]));
  const files = paths.map((path) => ({ path, sha: listed.get(path) }));
  if (!files.every((f): f is { path: string; sha: string } => typeof f.sha === "string")) {
    return "refused";
  }
  const key = keyOf(platform, request);
  if (viewed) await data.pullFileViews.mark(key, files);
  else await data.pullFileViews.unmark(key, paths);
  return "done";
}
