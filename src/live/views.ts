import type { Row } from "../db/scoped.js";
import type { LiveAccess, LiveCommentView, LiveRunView, LiveState } from "../shared/index.js";

// The API's projections of live rows (ADR-0056).

/** owner/repo from the pull request's https://host/owner/repo, else the account's name for the hash. */
function repoOf(run: Row<"liveRuns">, names: ReadonlyMap<string, string>): string | null {
  if (run.prRepository) return new URL(run.prRepository).pathname.slice(1);
  return names.get(run.repoHash) ?? null;
}

export const liveRunDto = (
  run: Row<"liveRuns">,
  owner: string,
  access: LiveAccess,
  names: ReadonlyMap<string, string> = new Map(),
) =>
  ({
    id: run.id,
    runId: run.runId,
    owner,
    access,
    target: run.target,
    source: run.source,
    repo: repoOf(run, names),
    prNumber: run.prNumber,
    state: run.state as LiveState,
    verdict: run.verdict,
    costUsd: run.costUsd,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  }) satisfies LiveRunView;

export const liveCommentDto = (c: Row<"liveComments">, viewer: { id: string; owner: boolean }) =>
  ({
    id: c.id,
    author: c.authorLogin,
    findingId: c.findingId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    removable: viewer.owner || c.authorId === viewer.id,
  }) satisfies LiveCommentView;
