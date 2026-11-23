import type { PullChecks, PullReview } from "../shared/index.js";
import { avatarOf } from "./changes.js";
import type { GithubGraphql } from "./github-host.js";
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

const LISTS = ["review", "authored", "merged"] as const;
type List = (typeof LISTS)[number];

const query = (
  checks: boolean,
) => `query($review: String!, $authored: String!, $merged: String!, $open: Int!, $done: Int!) {
  review: search(query: $review, type: ISSUE, first: $open) { issueCount nodes { ...P } }
  authored: search(query: $authored, type: ISSUE, first: $open) { issueCount nodes { ...P } }
  merged: search(query: $merged, type: ISSUE, first: $done) { issueCount nodes { ...P } }
}
${pullFragment(checks)}`;

export const pullFragment = (checks: boolean) => `fragment P on PullRequest {
  id number title url isDraft state createdAt updatedAt mergedAt additions deletions reviewDecision
  headRefOid headRefName baseRefName isCrossRepository
  author { login avatarUrl }
  repository { nameWithOwner }
  labels(first: ${MAX_LABELS}) { nodes { name } }
  ${checks ? "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }" : ""}
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
  };
}

const pulls = (s: Search) =>
  s.nodes.filter((n): n is PullNode => Boolean(n?.repository)).map(pullNodeItem);

export async function githubPulls(
  post: ReturnType<GithubGraphql>,
  now = Date.now(),
): Promise<PullListing | null> {
  const since = mergedSince(now).toISOString().slice(0, 10);
  const ask = (checks: boolean) =>
    post<Answer>({
      query: query(checks),
      variables: {
        review: "is:pr is:open archived:false review-requested:@me",
        authored: "is:pr is:open archived:false author:@me",
        merged: `is:pr is:merged author:@me merged:>=${since}`,
        open: OPEN_PER_LIST,
        done: MERGED_PER_LIST,
      },
    });
  let answer = await ask(true);
  // Without the App's checks permission GitHub nulls the whole pull.
  const lost = LISTS.some((l) => answer?.data?.[l]?.nodes.some((n) => n === null));
  if (answer?.errors && lost) answer = await ask(false);
  const data = answer?.data;
  if (!data?.review || !data.authored || !data.merged) return null;
  return {
    pulls: withRoles([
      { role: "reviewer", pulls: pulls(data.review) },
      { role: "author", pulls: [...pulls(data.authored), ...pulls(data.merged)] },
    ]),
    more: data.review.issueCount > OPEN_PER_LIST || data.authored.issueCount > OPEN_PER_LIST,
  };
}
