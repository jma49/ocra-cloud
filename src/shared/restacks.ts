// A stacked pull request rebased onto its new base by the server after the
// one below it merged (src/stack-merge/restack.ts): only in a repository
// that turned it on, as the ocra bot, with a force-push that holds only
// while the branch is where it was.

/**
 * How a restack ended: `restacked` force-pushed the rebased branch,
 * `conflict` pushed nothing (the author restacks it locally), `lease_lost`
 * found the branch moved and left it, `skipped` had nothing to do or was
 * not allowed (the reason says which).
 */
export const RESTACK_OUTCOMES = ["restacked", "conflict", "lease_lost", "skipped"] as const;
export type RestackOutcome = (typeof RESTACK_OUTCOMES)[number];

/**
 * Why a restack was skipped: the repository turned restacks off since it
 * was queued, a stack merge holds the pull request, the branch already
 * holds its new base, or the platform refused the bot's push.
 */
const RESTACK_SKIPS = ["switched_off", "stack_merge", "up_to_date", "push_refused"] as const;
export type RestackSkip = (typeof RESTACK_SKIPS)[number];

/** One restack of an enrolled repository, as its history lists it. */
export type RestackJobView = {
  id: string;
  /** The pull request rebased. */
  number: number;
  /** The merged pull request it was stacked on, or the restacked one below it. */
  parent: number;
  branch: string;
  /** The branch it was rebased onto. */
  onto: string;
  /** Its head before, and after a restack; null until it pushed. */
  from: string;
  to: string | null;
  state: "queued" | "running" | "done" | "failed";
  outcome: RestackOutcome | null;
  /** Why it was skipped or failed; null otherwise. */
  reason: string | null;
  /** The login of who asked for it on the pull request's page; null when a merge queued it. */
  askedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** GET /api/auto-review/repos/:id/restacks: the switch, and the newest restacks first. */
export type RestackHistoryView = { restack: boolean; jobs: RestackJobView[] };

/** What PUT /api/auto-review/repos/:id/restack answers. */
export type AutoReviewRestackView = { restack: boolean };

/**
 * GET /api/pulls/restack: whether a restack of the pull request can be asked
 * for (its repository is one ocra reviews, with restacks on), and its newest
 * one, a merge's or one asked for. `enrolled` without `offered` is a
 * repository ocra reviews with restacks switched off.
 */
export type PullRestackView = {
  enrolled: boolean;
  offered: boolean;
  job: RestackJobView | null;
};

/**
 * What POST /api/pulls/restack answers: `queued`, with the job; `running`
 * when one of the pull request is already under way (that one is the job);
 * `stack_changed` when a head is not the one the page read, or `held` while
 * a stack merge holds the pull request, so nothing was queued.
 */
export type PullRestackAnswer = PullRestackView & {
  outcome: "queued" | "running" | "stack_changed" | "held";
};
