import type { CallBudget } from "../calls.js";
import type { Spent } from "./reconcile.js";

// The 👍 and 👎 people gave ocra's comments of findings on a pull request,
// read as the bot, the enrolling account's link or the signed-in user:
// neither platform sends a webhook for them that ocra subscribes to. A read
// is bounded in comments and pages, checks `calls` before each call when a
// budget is given (src/calls.ts), and answers `spent` without calling when
// none is left. Nothing is written to the platform.

export type Reactions = { up: number; down: number };

/** Comments one read asks for at most: each is one call on GitLab. */
export const MAX_REACTION_COMMENTS = 20;

export interface CommentReactions {
  /**
   * The reactions on these comments of the pull request, by the platform's
   * comment id, of those it found; null when the platform failed or refused.
   */
  read(
    token: string,
    fullName: string,
    number: number,
    commentIds: readonly string[],
    calls?: CallBudget,
  ): Promise<Map<string, Reactions> | Spent | null>;
}
