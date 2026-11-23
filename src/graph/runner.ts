import type { Db } from "../db/client.js";
import { type ClaimedBuild, claimBuild } from "../db/graphs.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { accessToken } from "../platforms/links.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { AppBindings } from "../types.js";
import type { GraphBuilder } from "./builder.js";
import { gunzip, gzip } from "./gzip.js";

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
type Failure = "repo_gone" | "platform_gone" | "unlinked" | "tree_unreadable" | "build_failed";
const RETRIED: ReadonlySet<Failure> = new Set(["tree_unreadable", "build_failed"]);

const LEASE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000;
const MAX_BLOB_BYTES = 1_000_000;

class BuildFailure extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}

/** Runs the next due build; false when there was none. */
export async function runNextBuild(runner: GraphRunner): Promise<boolean> {
  const now = runner.now ?? (() => new Date());
  const leaseMs = runner.leaseMs ?? LEASE_MS;
  const build = await claimBuild(runner.db, now(), leaseMs);
  if (!build) return false;
  const graphs = scoped(runner.db, build.accountId).graphs;
  const signal = AbortSignal.timeout(Math.max(build.leaseUntil.getTime() - now().getTime(), 0));
  try {
    const built = await buildGraph(runner, build, signal);
    await graphs.finishBuild(build.id, build.attempts, built, now());
  } catch (e) {
    // A platform read cut short by the lease returns null, which would read as an unreadable tree.
    const reason = !signal.aborted && e instanceof BuildFailure ? e.reason : "build_failed";
    const retry = RETRIED.has(reason) && build.attempts < MAX_ATTEMPTS;
    logError("graph_build_failed", { build: build.id, reason, error: errorName(e), retry });
    const retryAt = retry ? new Date(now().getTime() + RETRY_AFTER_MS * build.attempts) : null;
    await graphs.releaseBuild(build.id, build.attempts, reason, retryAt, now());
  }
  return true;
}

async function buildGraph(runner: GraphRunner, build: ClaimedBuild, signal: AbortSignal) {
  const data = scoped(runner.db, build.accountId);
  const repo = await data.get("graphRepos", build.graphRepoId);
  if (!repo) throw new BuildFailure("repo_gone");
  const platform = runner.platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
  if (!platform) throw new BuildFailure("platform_gone");
  const token = await accessToken(data, runner.env, platform);
  if (!token) throw new BuildFailure("unlinked");
  const tree = await platform.contents.tree(token, repo, build.commit, signal);
  if (!tree) throw new BuildFailure("tree_unreadable");
  const previous = await data.graphs.newestGraph(repo.id);
  const output = await runner.builder({
    previous: previous?.content ? await gunzip(new Uint8Array(previous.content)) : undefined,
    tree: tree.entries,
    readBlob: (blobId) => platform.contents.blob(token, repo, blobId, MAX_BLOB_BYTES, signal),
    revision: build.commit,
    maxBlobBytes: MAX_BLOB_BYTES,
    signal,
  });
  return {
    content: await gzip(output.graph),
    files: output.files,
    parsed: output.parsed,
    reused: output.reused,
    skipped: output.skipped,
    truncated: tree.truncated,
  };
}
