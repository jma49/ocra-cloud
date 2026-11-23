import type { CodePlatformKind } from "./domain.js";
import type { PullActionOutcome } from "./pull-page.js";

// Several of ocra's checked fixes and review suggestions applied to a pull
// request as one commit (POST /api/pulls/apply-batch), as the signed-in user.

/** Items one batch takes: findings and suggestions together. */
export const MAX_BATCH_ITEMS = 20;

export const BATCH_ITEM_KINDS = ["finding", "suggestion"] as const;
export type BatchItemKind = (typeof BATCH_ITEM_KINDS)[number];

/** A finding's id (its fix), or a suggestion's id as GET /api/pulls/threads lists it. */
export type BatchItem = { kind: BatchItemKind; id: string };

/**
 * Applies the items to the pull request at `head`, in one commit. Where two
 * change the same lines differently, the one earlier in the list is applied;
 * the same change twice is applied once, for both.
 */
export type PullBatchRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  items: BatchItem[];
};

/**
 * Why an item was left out: `not_found` (no such finding of this pull
 * request, or suggestion on it), `no_fix` (a finding without a checked
 * fix), `stale` (written for another head, or its lines changed since),
 * `conflict` (an earlier item changes some of the same lines differently),
 * `not_applicable` (its file is not text, too large, outside the repository,
 * or has no such lines), `not_sent` (it could be applied, but the commit was
 * not made: the outcome says why).
 */
export type BatchSkipReason =
  | "not_found"
  | "no_fix"
  | "stale"
  | "conflict"
  | "not_applicable"
  | "not_sent";

export type BatchItemOutcome = BatchItem & {
  applied: boolean;
  /** null when applied. */
  reason: BatchSkipReason | null;
};

/**
 * `done` when one commit applied every item marked applied; `not_applicable`
 * when no item could be, and nothing was sent; `head_moved` and `refused`
 * as for any write on the pull request. Items in request order.
 */
export type PullBatchView = { outcome: PullActionOutcome; items: BatchItemOutcome[] };
