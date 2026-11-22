import {
  type CycleScope,
  firstOther,
  MAX_CYCLE_PULLS,
  type MergedPull,
  type PullCycles,
} from "./cycles.js";
import type { GithubGraphql } from "./github-host.js";

const QUERY = `query($q: String!, $n: Int!) {
  search(query: $q, type: ISSUE, first: $n) {
    nodes { ... on PullRequest {
      number title url createdAt mergedAt
      author { login }
      repository { nameWithOwner }
      reviews(first: 20) { nodes { submittedAt author { login } } }
    } }
  }
}`;

type Node = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string } | null;
  reviews: { nodes: ({ submittedAt: string | null; author: { login: string } | null } | null)[] };
};
type Answer = { data?: { search?: { nodes: (Node | null)[] } } };

export function githubCycles(post: GithubGraphql): PullCycles {
  return {
    async merged(token, scope: CycleScope, since) {
      const who = "mine" in scope ? "author:@me" : `repo:${scope.repo}`;
      const q = `is:pr is:merged ${who} merged:>=${since.toISOString().slice(0, 10)} sort:updated-desc`;
      const answer = await post(token)<Answer>({
        query: QUERY,
        variables: { q, n: MAX_CYCLE_PULLS },
      });
      const nodes = answer?.data?.search?.nodes;
      if (!nodes) return null;
      return nodes
        .filter((n): n is Node & { mergedAt: string } => Boolean(n?.repository && n.mergedAt))
        .map((n): MergedPull => {
          const author = n.author?.login ?? null;
          const reviews = n.reviews.nodes.flatMap((r) =>
            r ? [{ by: r.author?.login ?? null, at: r.submittedAt }] : [],
          );
          return {
            repo: n.repository?.nameWithOwner ?? "",
            number: n.number,
            title: n.title,
            url: n.url,
            author,
            createdAt: n.createdAt,
            mergedAt: n.mergedAt,
            firstReviewAt: firstOther(author, n.mergedAt, reviews),
          };
        });
    },
  };
}
