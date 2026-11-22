import type { PullActionOutcome } from "../shared/index.js";

// Which of a pull request's files the signed-in user ticked as viewed, on
// a platform that keeps it (GitHub). A tick the platform cleared because
// the file changed since reads as not viewed. Nothing is kept here.

type ViewedMark = { head: string; paths: readonly string[]; viewed: boolean };

export interface PullFileViewed {
  /**
   * Whether each file is ticked, by path, for at most its first 1,000
   * files; null when the platform could not be reached.
   */
  list(token: string, fullName: string, number: number): Promise<Map<string, boolean> | null>;
  /** `head_moved` when the pull request is not at `head`, `refused` when the platform said no. */
  mark(
    token: string,
    fullName: string,
    number: number,
    mark: ViewedMark,
  ): Promise<PullActionOutcome | null>;
}
