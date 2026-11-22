import type { MergeQueueView, PullActionOutcome } from "../shared/index.js";

// The platform's own merge queue, used as the signed-in user: GitHub's
// merge queue, GitLab's merge trains. The queue runs the checks and merges;
// ocra only puts a pull request in it, takes it out and shows where it is.
// Each answers null when the platform could not be reached.

export interface MergeQueue {
  status(token: string, fullName: string, number: number): Promise<MergeQueueView | null>;
  /** Queues the pull request as it is at `head`; one that moved since is `head_moved`. */
  enqueue(
    token: string,
    fullName: string,
    number: number,
    head: string,
  ): Promise<PullActionOutcome | null>;
  dequeue(token: string, fullName: string, number: number): Promise<PullActionOutcome | null>;
}
