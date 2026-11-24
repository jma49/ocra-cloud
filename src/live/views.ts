import { type PullRef, pullKey } from "../db/pull-flows.js";
import type { Row } from "../db/scoped.js";
import type { LiveAccess, LiveCommentView, LiveRunView, LiveState } from "../shared/index.js";

// The API's projections of live rows (ADR-0056).

/** owner/repo from the pull request's https://host/owner/repo, else the account's name for the hash. */
function repoOf(run: Row<"liveRuns">, names: ReadonlyMap<string, string>): string | null {
  if (run.prRepository) return new URL(run.prRepository).pathname.slice(1);
  return names.get(run.repoHash) ?? null;
}

/** Where the run's pull request lives, when it reviewed one. */
export function pullOf(run: Row<"liveRuns">): PullRef | null {
  if (!run.prRepository || run.prNumber === null) return null;
  const url = new URL(run.prRepository);
  return { host: url.host, fullName: url.pathname.slice(1), number: run.prNumber };
}

/** Names and titles are the owner's to give; others see only a pull request's path. */
export type OwnerNames = {
  repos: ReadonlyMap<string, string>;
  titles: ReadonlyMap<string, string>;
};

const NONE: OwnerNames = { repos: new Map(), titles: new Map() };

export function liveRunDto(
  run: Row<"liveRuns">,
  owner: string,
  access: LiveAccess,
  names: OwnerNames = NONE,
) {
  const pull = pullOf(run);
  return {
    id: run.id,
    runId: run.runId,
    owner,
    access,
    target: run.target,
    title: (pull && names.titles.get(pullKey(pull))) ?? null,
    source: run.source,
    repo: repoOf(run, names.repos),
    prNumber: run.prNumber,
    state: run.state as LiveState,
    verdict: run.verdict,
    costUsd: run.costUsd,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  } satisfies LiveRunView;
}

export const liveCommentDto = (c: Row<"liveComments">, viewer: { id: string; owner: boolean }) =>
  ({
    id: c.id,
    author: c.authorLogin,
    findingId: c.findingId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    removable: viewer.owner || c.authorId === viewer.id,
  }) satisfies LiveCommentView;
