import type { Db } from "../db/client.js";
import { type ClaimedBuild, claimBuild } from "../db/graphs.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { AppBindings } from "../types.js";
import type { GraphBuilder } from "./builder.js";
import { gunzip, gzipBase64 } from "./gzip.js";

// Builds the next queued graph: reads the commit's tree and only the
// blobs the previous graph lacks, through the platform as the account, and
// keeps the new graph. A failure is recorded on the build, never thrown.

export type GraphRunner = {
  db: Db;
  env: AppBindings;
  platforms: readonly CodePlatform[];
  builder: GraphBuilder;
  /** How long a run owns its build; the build is aborted at the end of it. */
  leaseMs?: number;
  now?: () => Date;
};

/** Why a build failed, as stored and logged; the retried ones are retried. */
export const BUILD_FAILURES = [
  "repo_gone",
  "platform_gone",
  "unlinked",
  "no_bot",
  "tree_unreadable",
  "clone_failed",
  "too_large",
  "build_failed",
] as const;
export type BuildFailure = (typeof BUILD_FAILURES)[number];
const RETRIED: ReadonlySet<BuildFailure> = new Set([
  "tree_unreadable",
  "clone_failed",
  "build_failed",
]);

export const BUILD_LEASE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;
export const MAX_BLOB_BYTES = 1_000_000;

/** Records a claimed build's failure: queued again later while it may pass, given up otherwise. */
export async function failBuild(
  db: Db,
  build: Pick<ClaimedBuild, "id" | "accountId" | "attempts">,
  reason: BuildFailure,
  now: Date,
  error?: string,
): Promise<void> {
  const retry = RETRIED.has(reason) && build.attempts < MAX_ATTEMPTS;
  logError("graph_build_failed", { build: build.id, reason, retry, ...(error ? { error } : {}) });
  const retryAt = retry ? new Date(now.getTime() + RETRY_AFTER_MS * build.attempts) : null;
  await scoped(db, build.accountId).graphs.releaseBuild(
    build.id,
    build.attempts,
    reason,
    retryAt,
    now,
  );
}

class BuildFailed extends Error {
  constructor(readonly reason: BuildFailure) {
    super(reason);
  }
}

/** Runs the next due build; false when there was none. */
export async function runNextBuild(runner: GraphRunner): Promise<boolean> {
  const now = runner.now ?? (() => new Date());
  const leaseMs = runner.leaseMs ?? BUILD_LEASE_MS;
  const build = await claimBuild(runner.db, now(), leaseMs);
  if (!build) return false;
  const graphs = scoped(runner.db, build.accountId).graphs;
  const signal = AbortSignal.timeout(Math.max(build.leaseUntil.getTime() - now().getTime(), 0));
  try {
    const built = await buildGraph(runner, build, signal);
    await graphs.finishBuild(build.id, build.attempts, built, now());
  } catch (e) {
    // A platform read cut short by the lease returns null, which would read as an unreadable tree.
    const reason = !signal.aborted && e instanceof BuildFailed ? e.reason : "build_failed";
    await failBuild(runner.db, build, reason, now(), errorName(e));
  }
  return true;
}

async function buildGraph(runner: GraphRunner, build: ClaimedBuild, signal: AbortSignal) {
  const data = scoped(runner.db, build.accountId);
  const repo = await data.get("graphRepos", build.graphRepoId);
  if (!repo) throw new BuildFailed("repo_gone");
  const platform = runner.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) throw new BuildFailed("platform_gone");
  const token = await accessToken(data, runner.env, platform);
  if (!token) throw new BuildFailed("unlinked");
  const tree = await platform.contents.tree(token, repo, build.commit, signal);
  if (!tree) throw new BuildFailed("tree_unreadable");
  const previous = await data.graphs.newestGraph(repo.id);
  const output = await runner.builder({
    previous: previous ? await gunzip(previous.content) : undefined,
    tree: tree.entries,
    readBlob: (blobId) => platform.contents.blob(token, repo, blobId, MAX_BLOB_BYTES, signal),
    revision: build.commit,
    maxBlobBytes: MAX_BLOB_BYTES,
    signal,
  });
  return {
    content: await gzipBase64(output.graph),
    files: output.files,
    parsed: output.parsed,
    reused: output.reused,
    skipped: output.skipped,
    truncated: tree.truncated,
  };
}
