import type {
  BranchUpdateOutcome,
  PullActionOutcome,
  PullLabel,
  PullState,
} from "../shared/index.js";
import { platformLimitedUntil } from "./rate-limit.js";

// A pull request's labels and draft state, read and changed as the
// signed-in user. Each answers null when the platform could not be reached.

type LabelListing = { applied: string[]; available: PullLabel[]; truncated: boolean };

type LabelEdit = { add: readonly string[]; remove: readonly string[] };

type DraftState = { draft: boolean; state: PullState };

export interface PullEdits {
  labels(token: string, fullName: string, number: number): Promise<LabelListing | null>;
  editLabels(
    token: string,
    fullName: string,
    number: number,
    edit: LabelEdit,
  ): Promise<PullActionOutcome | null>;
  draft(token: string, fullName: string, number: number): Promise<DraftState | null>;
  /** `refused`, unsent, for a pull request that is not open; `done`, unsent, when it already is so. */
  setDraft(
    token: string,
    fullName: string,
    number: number,
    draft: boolean,
  ): Promise<PullActionOutcome | null>;
  /**
   * Brings the branch up to date with its base, if its head is still
   * `head`: `head_moved`, unsent, when it is not.
   */
  updateBranch(
    token: string,
    fullName: string,
    number: number,
    head: string,
  ): Promise<BranchUpdateOutcome | "head_moved" | null>;
}

/**
 * A refusal to push as `forbidden`, but one the platform made because the
 * user's allowance is used up: null, which the request answers as that.
 */
export const forbiddenUnlessLimited = (): "forbidden" | null =>
  platformLimitedUntil() === null ? "forbidden" : null;

/** A platform's label colour as `#rrggbb`: GitHub writes it without the `#`. */
export function labelColor(color: unknown): string | null {
  const hex = typeof color === "string" ? /^#?([0-9a-f]{6})$/i.exec(color)?.[1] : undefined;
  return hex ? `#${hex.toLowerCase()}` : null;
}

/** Names compared as the platforms compare them, without case. */
export const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
