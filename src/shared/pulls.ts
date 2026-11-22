export type PullRole = "reviewer" | "author";
export type PullChecks = "passing" | "failing" | "pending" | null;
export type PullReview = "approved" | "changes_requested" | "required" | null;
/** The account's newest ocra review of the pull request: blocking when its verdict blocks a merge; null before any. */
export type PullAiVerdict = "blocking" | "not_blocking" | null;

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
  /** As the platform lists them; empty where it gives none. */
  labels: string[];
  verdict: PullAiVerdict;
  additions: number | null;
  deletions: number | null;
};

/** Every listed field narrows the view; within a field any value matches. */
export type PullFilters = {
  /** reviewer: my review was asked for; author: I opened it. */
  roles?: PullRole[] | undefined;
  /** me: I opened it; others: someone else did. */
  authoredBy?: "me" | "others" | undefined;
  states?: PullItem["state"][] | undefined;
  drafts?: "include" | "exclude" | "only" | undefined;
  /** `host/owner/repo`. */
  repos?: string[] | undefined;
  /** Platform logins. */
  authors?: string[] | undefined;
  checks?: NonNullable<PullChecks>[] | undefined;
  /** none: the platform states no review decision. */
  reviews?: (NonNullable<PullReview> | "none")[] | undefined;
  /** unreviewed: no ocra review of it yet. */
  verdicts?: (NonNullable<PullAiVerdict> | "unreviewed")[] | undefined;
  /** Any of these labels, compared without case. */
  labels?: string[] | undefined;
  updatedWithinDays?: number | undefined;
};

export type PullView = {
  id: string;
  name: string;
  filters: PullFilters;
  position: number;
  hidden: boolean;
};

/** What a new view, or a default one, is made of. */
export type PullViewDraft = { name: string; filters: PullFilters };

/** GET /api/pull-views: the account's views; `defaults` only while it has none. */
export type PullViewsAnswer = { views: PullView[]; defaults: PullViewDraft[] };

/** Shown to an account that has no views of its own, and kept by POST /api/pull-views/defaults. */
export const DEFAULT_PULL_VIEWS: readonly PullViewDraft[] = [
  {
    name: "Needs my review",
    filters: { roles: ["reviewer"], authoredBy: "others", states: ["open"], drafts: "exclude" },
  },
  { name: "My open PRs", filters: { authoredBy: "me", states: ["open"] } },
  {
    name: "Waiting on others",
    filters: {
      authoredBy: "me",
      states: ["open"],
      drafts: "exclude",
      reviews: ["required", "none"],
    },
  },
  { name: "Recently merged", filters: { authoredBy: "me", states: ["merged"] } },
];

/**
 * One section of GET /api/platforms/pulls?group=views, naming its pulls by
 * platform host and the platform's id; `view.id` starts with `default:` for
 * a default not kept.
 */
export type PullSection = { view: PullView; pulls: { host: string; id: string }[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const any = <T>(allowed: readonly T[] | undefined, value: T) => !allowed || allowed.includes(value);

/** Whether a pull request on a platform host belongs in a view with these filters at a time. */
export function matchesPullFilters(
  p: PullItem & { host: string },
  f: PullFilters,
  now: number,
): boolean {
  const drafts = f.drafts ?? "include";
  if (drafts === "exclude" && p.draft) return false;
  if (drafts === "only" && !p.draft) return false;
  const mine = p.roles.includes("author");
  if (f.authoredBy === "me" && !mine) return false;
  if (f.authoredBy === "others" && mine) return false;
  if (f.updatedWithinDays !== undefined) {
    const at = Date.parse(p.updatedAt);
    if (!(at >= now - f.updatedWithinDays * DAY_MS)) return false;
  }
  const labels = f.labels?.map((l) => l.toLowerCase());
  return (
    (!f.roles || p.roles.some((role) => f.roles?.includes(role))) &&
    any(f.states, p.state) &&
    any(f.repos, `${p.host}/${p.repo}`) &&
    (!f.authors || (p.author !== null && f.authors.includes(p.author))) &&
    (!f.checks || (p.checks !== null && f.checks.includes(p.checks))) &&
    any(f.reviews, p.review ?? "none") &&
    any(f.verdicts, p.verdict ?? "unreviewed") &&
    (!labels || p.labels.some((l) => labels.includes(l.toLowerCase())))
  );
}
