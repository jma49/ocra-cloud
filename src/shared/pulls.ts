export type PullSection = "review" | "authored";
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
  createdAt: string;
  updatedAt: string;
  sections: PullSection[];
  checks: PullChecks;
  review: PullReview;
  additions: number | null;
  deletions: number | null;
};
