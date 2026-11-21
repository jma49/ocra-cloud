export type PullRole = "reviewer" | "author";
export type PullChecks = "passing" | "failing" | "pending" | null;
export type PullReview = "approved" | "changes_requested" | "required" | null;

export type PullItem = {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string | null;
  draft: boolean;
  state: "open" | "merged";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  roles: PullRole[];
  checks: PullChecks;
  review: PullReview;
  additions: number | null;
  deletions: number | null;
};
