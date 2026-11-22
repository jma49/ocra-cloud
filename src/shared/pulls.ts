import type { CodePlatformKind } from "./domain.js";
import type { PullStackPlace } from "./stacks.js";

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
  /** The head commit, where the listing names it. */
  head: string | null;
  /** Changed since the account last saw it, or marked unread. */
  unread: boolean;
  /** What changed first, of what counts; only on an unread pull. */
  unreadReason?: PullUnreadReason;
  /**
   * Review threads the user started on it with a reply from someone else
   * newer than both what they last saw of it and their own last reply in
   * the thread; only threads started since ocra began keeping them count.
   */
  repliesWaiting: number;
  /** Its place among the listed open pulls of its repository stacked with it; none when unstacked. */
  stack?: PullStackPlace;
};

/**
 * Why a pull request is unread: opened since the inbox's baseline and never
 * seen, marked unread, new commits, a merge, a new ocra review, a reply
 * waiting in a review thread the user started, or other activity on the
 * platform (reviews, comments, a title or label change).
 */
export type PullUnreadReason =
  | "new"
  | "marked"
  | "commits"
  | "merged"
  | "ocra_review"
  | "replies"
  | "activity";

/** At most this many pull requests per POST /api/pulls/seen/bulk. */
export const MAX_SEEN_BULK = 250;

/** One pull request as the inbox saw it, to mark read: its updatedAt and head from the listing. */
export type PullSeenMark = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  updatedAt: string;
  head: string | null;
};

/** POST /api/pulls/seen/bulk: read needs each pull's updatedAt; unread takes it and head as given or not. */
export type PullSeenBulkRequest =
  | { read: true; pulls: PullSeenMark[] }
  | { read: false; pulls: Pick<PullSeenMark, "platform" | "repo" | "number">[] };

/** What the account last saw of a pull request; times in milliseconds. */
export type PullSeenState = {
  updatedAt: number;
  head: string | null;
  /** Marked unread by hand. */
  unread: boolean;
  /** When it was marked, by the server's clock, as ocra reviews are. */
  seenAt: number;
};

/**
 * Whether a listed pull request changed since the account saw it, and the
 * first reason that holds. reviewedAt is when the account's newest ocra
 * review of it was made, repliesWaiting its threads' replies waiting for
 * the user; one with no mark counts as seen as it stood at since, the
 * account's inbox baseline.
 */
export function pullUnread(
  pull: Pick<PullItem, "createdAt" | "updatedAt" | "head" | "mergedAt">,
  mark: PullSeenState | undefined,
  reviewedAt: number | null,
  since: number,
  repliesWaiting = 0,
): { unread: boolean; unreadReason?: PullUnreadReason } {
  const reason = ((): PullUnreadReason | null => {
    if (!mark && Date.parse(pull.createdAt) > since) return "new";
    const seen = mark ?? { updatedAt: since, head: null, unread: false, seenAt: since };
    if (seen.unread) return "marked";
    const moved = Date.parse(pull.updatedAt) > seen.updatedAt;
    if (moved && pull.head !== null && seen.head !== null && pull.head !== seen.head) {
      return "commits";
    }
    if (moved && pull.mergedAt !== null && Date.parse(pull.mergedAt) > seen.updatedAt) {
      return "merged";
    }
    if (reviewedAt !== null && reviewedAt > seen.seenAt) return "ocra_review";
    if (repliesWaiting > 0) return "replies";
    return moved ? "activity" : null;
  })();
  return reason ? { unread: true, unreadReason: reason } : { unread: false };
}

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
