import { DAY } from "../time.js";

// Whether the inbox's index stands for an enrolled repository: the daily
// reconciliation read all its open pull requests lately, so a webhook it
// missed is no older than that. A paused repository is not reconciled.

/** A day, and one more for runs that did not happen or could not read it. */
const FRESH_FOR_MS = 2 * DAY;

export const freshRepo = (
  repo: { paused: string | null; pullsIndexedAt: Date | null },
  now: Date,
): boolean =>
  repo.paused === null &&
  repo.pullsIndexedAt !== null &&
  now.getTime() - repo.pullsIndexedAt.getTime() <= FRESH_FOR_MS;
