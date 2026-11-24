import type {
  FixFailureCause,
  MendItemOutcome,
  MendItemReason,
  MendLevel,
  MendOutcome,
} from "@open-cr-agent/cloud-contract";

// The fix loop of a pull request (ADR-0078): findings a person asked ocra to
// fix, worked on a round at a time by `ocra mend` in the runner. Each edit
// passes the loop's gate and its verifier before the bot commits it to the
// branch, where the pull request's own checks test it. Nothing of the
// repository runs.

/** A repository's level until the account lets the bot commit there. */
export const DEFAULT_MEND_LEVEL: MendLevel = "propose";

/** Findings one request asks fixes for. */
export const MAX_MEND_REQUEST = 20;

/** What the level setting of an enrolled repository answers. */
export type AutoReviewMendView = { mend: MendLevel; checks: boolean };

/** A finding asked of the loop: it waits while `outcome` is null. */
export type MendItemView = {
  finding: string;
  outcome: MendItemOutcome | null;
  /** Why no edit was written for it, as `ocra mend` says; null when one was, or while it waits. */
  reason: MendItemReason | null;
  /** What failed when the reason is `failed`; null otherwise. */
  cause: FixFailureCause | null;
  /** The commit that fixed it; null otherwise. */
  commit: string | null;
  /** ISO 8601. */
  requestedAt: string;
  finishedAt: string | null;
};

/** A failed check the loop's last round worked on, by the check's name, and what became of it. */
export type MendCheckView = {
  check: string;
  outcome: MendItemOutcome;
  reason: MendItemReason | null;
  cause: FixFailureCause | null;
};

/** The loop's last round, or the one that waits or runs. */
type MendLoopView = {
  state: "queued" | "running" | "done" | "failed";
  /** How its last round ended; null before the first did. */
  outcome: MendOutcome | null;
  /** Why the round failed, was not run, or waits for a retry; null otherwise. */
  error: string | null;
  finishedAt: string | null;
};

/**
 * GET /api/auto-review/mends?platform&repo&number: the pull request's loop.
 * `level` is its repository's, null for one the account did not enroll.
 */
export type PullMendView = {
  level: MendLevel | null;
  loop: MendLoopView | null;
  items: MendItemView[];
  /** The failed checks its last round worked on; empty when it worked on none. */
  checks: MendCheckView[];
};

/**
 * What POST /api/auto-review/mends answers (body `{ findings }`, the ids of
 * open findings of one pull request): `queued`, or `requested` when each
 * already waits or was answered; `not_enabled` when the repository's level
 * is not `commit`. A day's requests used up before any was asked answer
 * daily_limit.
 */
export type MendRequestView = {
  outcome: "queued" | "requested" | "not_enabled";
  mend: PullMendView;
};
