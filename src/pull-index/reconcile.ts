import type { Scoped } from "../db/scoped.js";
import type { ReconciledPull, ReconcileListing } from "../platforms/reconcile.js";
import { applyFacts, type PullFacts } from "./facts.js";

// The daily reconciliation's listings of an enrolled repository, read into
// the inbox's index with no call of their own: each pull request as the
// platform has it now (a webhook newer than the listing stands), and,
// when the open ones were listed in full, those the index holds open that
// are open no more closed, and the repository marked fresh (./fresh.ts).

function factsOf(p: ReconciledPull): PullFacts | null {
  if (!p.updatedAt || !p.listed) return null;
  const { listed } = p;
  return {
    number: p.number,
    changedAt: p.updatedAt,
    pullId: listed.pullId,
    title: p.title,
    url: listed.url,
    author: p.author,
    authorId: p.authorId,
    authorAvatar: listed.authorAvatar,
    draft: p.draft,
    state: p.state,
    openedAt: p.openedAt,
    mergedAt: p.state === "merged" ? p.closedAt : null,
    closedAt: p.closedAt,
    labels: listed.labels,
    head: listed.head,
    branches: listed.branches,
    reviewerIds: p.asks.flatMap((a) => (a.team ? [] : [a.id])),
    assigneeIds: listed.assigneeIds,
  };
}

/** How many rows the listings changed. */
export async function indexReconciled(
  data: Scoped,
  reviewRepoId: string,
  closed: ReconcileListing,
  open: ReconcileListing,
  at: Date,
): Promise<number> {
  let changed = 0;
  for (const p of [...closed.pulls, ...open.pulls]) {
    const facts = factsOf(p);
    if (facts && (await applyFacts(data, reviewRepoId, p.number, () => facts))) changed++;
  }
  if (open.more) return changed;
  const listed = new Set([...closed.pulls, ...open.pulls].map((p) => p.number));
  const held = await data.pullIndex.openNumbers(reviewRepoId);
  changed += await data.pullIndex.close(
    reviewRepoId,
    held.filter((n) => !listed.has(n)),
    at,
  );
  await data.pullIndex.indexed(reviewRepoId, at);
  return changed;
}
