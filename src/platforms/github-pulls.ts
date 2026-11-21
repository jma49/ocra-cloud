import type { PullChecks, PullItem, PullReview } from "../shared/index.js";
import { mergeSections, PULLS_PER_SECTION, type PullListing } from "./platform.js";

const query = (checks: boolean) => `query($review: String!, $authored: String!, $n: Int!) {
  review: search(query: $review, type: ISSUE, first: $n) { issueCount nodes { ...P } }
  authored: search(query: $authored, type: ISSUE, first: $n) { issueCount nodes { ...P } }
}
fragment P on PullRequest {
  id number title url isDraft createdAt updatedAt additions deletions reviewDecision
  author { login }
  repository { nameWithOwner }
  ${checks ? "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }" : ""}
}`;

type Node = {
  id?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Search = { issueCount: number; nodes: Node[] };
type Answer = { data?: { review?: Search; authored?: Search }; errors?: unknown[] };

const CHECKS: Record<string, PullChecks> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
};
const REVIEW: Record<string, PullReview> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "required",
};

function item(n: Node): Omit<PullItem, "sections"> {
  const rollup = n.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  return {
    id: n.id ?? `${n.repository.nameWithOwner}#${n.number}`,
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository.nameWithOwner,
    author: n.author?.login ?? null,
    draft: n.isDraft,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    checks: (rollup && CHECKS[rollup]) || null,
    review: (n.reviewDecision && REVIEW[n.reviewDecision]) || null,
    additions: n.additions,
    deletions: n.deletions,
  };
}

const pulls = (s: Search | undefined) =>
  (s?.nodes ?? []).filter((n) => n?.repository && typeof n.number === "number");

export async function githubPulls(
  post: <T>(path: string, body: unknown) => Promise<T | null>,
): Promise<PullListing | null> {
  const ask = (checks: boolean) =>
    post<Answer>("/graphql", {
      query: query(checks),
      variables: {
        review: "is:pr is:open archived:false review-requested:@me",
        authored: "is:pr is:open archived:false author:@me",
        n: PULLS_PER_SECTION,
      },
    });
  let answer = await ask(true);
  // Without the App's checks permission GitHub nulls the whole pull.
  const lost = (s: Search | undefined) => s?.nodes.some((n) => n === null) ?? false;
  if (answer?.errors && (lost(answer.data?.review) || lost(answer.data?.authored))) {
    answer = await ask(false);
  }
  const data = answer?.data;
  if (!data?.review || !data.authored) return null;
  return {
    pulls: mergeSections([
      { section: "review", pulls: pulls(data.review).map(item) },
      { section: "authored", pulls: pulls(data.authored).map(item) },
    ]),
    more:
      data.review.issueCount > PULLS_PER_SECTION || data.authored.issueCount > PULLS_PER_SECTION,
  };
}
