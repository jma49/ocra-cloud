import type { PullChecks, PullReview } from "../shared/index.js";
import { avatarOf } from "./changes.js";
import type { GithubGraphql } from "./github-host.js";
import { queueStateOf } from "./github-queue.js";
import {
  type ListedPull,
  labelsOf,
  MAX_LABELS,
  MERGED_PER_LIST,
  mergedSince,
  OPEN_PER_LIST,
  type PullListing,
  withRoles,
} from "./pulls.js";

const LISTS = ["review", "authored", "assigned", "merged"] as const;
type List = (typeof LISTS)[number];

// One request per list, sent together: GitHub answers a request's searches
// one after another, so one request with all four took the sum of them
// (3.5 s for the inbox, live).
const query = (list: List, checks: boolean, queue: boolean) => `query($q: String!, $n: Int!) {
  ${list}: search(query: $q, type: ISSUE, first: $n) { issueCount nodes { ...P } }
}
${pullFragment(checks, queue)}`;

export const pullFragment = (checks: boolean, queue = false) => `fragment P on PullRequest {
  id number title url isDraft state createdAt updatedAt mergedAt additions deletions reviewDecision
  headRefOid headRefName baseRefName isCrossRepository
  author { login avatarUrl }
  repository { nameWithOwner }
  labels(first: ${MAX_LABELS}) { nodes { name } }
  ${checks ? "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }" : ""}
  ${queue ? "mergeQueueEntry { state }" : ""}
}`;

export type PullNode = {
  id?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRefOid?: string | null;
  headRefName?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  author: { login: string; avatarUrl?: string } | null;
  repository: { nameWithOwner: string };
  labels?: { nodes: ({ name: string } | null)[] } | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  mergeQueueEntry?: { state: string } | null;
};
type Search = { issueCount: number; nodes: (PullNode | null)[] };
type Answer = { data?: Partial<Record<List, Search>>; errors?: unknown[] };

export const CHECKS: Record<string, PullChecks> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
};
export const REVIEW: Record<string, PullReview> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "required",
};

export function pullNodeItem(n: PullNode): ListedPull {
  const rollup = n.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  const queued = n.mergeQueueEntry ? queueStateOf(n.mergeQueueEntry.state) : undefined;
  return {
    id: n.id ?? `${n.repository.nameWithOwner}#${n.number}`,
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository.nameWithOwner,
    author: n.author?.login ?? null,
    authorAvatar: avatarOf(n.author?.avatarUrl),
    draft: n.isDraft,
    state: n.state === "MERGED" ? "merged" : "open",
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    mergedAt: n.mergedAt,
    checks: (rollup && CHECKS[rollup]) || null,
    review: (n.reviewDecision && REVIEW[n.reviewDecision]) || null,
    labels: labelsOf((n.labels?.nodes ?? []).flatMap((l) => (l ? [l.name] : []))),
    additions: n.additions,
    deletions: n.deletions,
    head: n.headRefOid ?? null,
    branches:
      n.headRefName && n.baseRefName && n.isCrossRepository === false
        ? { head: n.headRefName, base: n.baseRefName }
        : null,
    ...(queued ? { queued } : {}),
  };
}

const pulls = (s: Search) =>
  s.nodes.filter((n): n is PullNode => Boolean(n?.repository)).map(pullNodeItem);

export async function githubPulls(
  post: ReturnType<GithubGraphql>,
  now = Date.now(),
): Promise<PullListing | null> {
  const since = mergedSince(now).toISOString().slice(0, 10);
  const searches: Record<List, { q: string; n: number }> = {
    review: { q: "is:pr is:open archived:false review-requested:@me", n: OPEN_PER_LIST },
    authored: { q: "is:pr is:open archived:false author:@me", n: OPEN_PER_LIST },
    assigned: { q: "is:pr is:open archived:false assignee:@me", n: OPEN_PER_LIST },
    merged: { q: `is:pr is:merged author:@me merged:>=${since}`, n: MERGED_PER_LIST },
  };
  const ask = (list: List, checks: boolean, queue: boolean) =>
    post<Answer>({ query: query(list, checks, queue), variables: searches[list] });
  const search = async (list: List) => {
    const full = await ask(list, true, true);
    // A GitHub without merge queues refuses the whole query for the field it does not know.
    const answer = full?.errors && !full.data ? await ask(list, true, false) : full;
    // Without the App's checks permission GitHub nulls the whole pull.
    const lost = answer?.data?.[list]?.nodes.some((n) => n === null);
    return (answer?.errors && lost ? await ask(list, false, false) : answer)?.data?.[list];
  };
  const [review, authored, assigned, merged] = await Promise.all(LISTS.map(search));
  if (!review || !authored || !assigned || !merged) return null;
  return {
    pulls: withRoles([
      { role: "reviewer", pulls: pulls(review) },
      { role: "author", pulls: [...pulls(authored), ...pulls(merged)] },
      { role: "assignee", pulls: pulls(assigned) },
    ]),
    more: [review, authored, assigned].some((l) => l.issueCount > OPEN_PER_LIST),
  };
}
