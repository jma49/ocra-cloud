// How long a platform's merged pull requests took: opened to first review
// by someone other than the author, and opened to merged. Read live as the
// signed-in user, so they see only what the platform shows them.

/** The user's own pull requests, or every author's in one repository. */
export type CycleScope = { mine: true } | { repo: string };

export type MergedPull = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string;
  mergedAt: string;
  /** null when nobody but the author reviewed or commented before it merged. */
  firstReviewAt: string | null;
};

/** At most this many pull requests a reading, newest merged first. */
export const MAX_CYCLE_PULLS = 50;

export interface PullCycles {
  /** null when the platform refused or failed. */
  merged(token: string, scope: CycleScope, since: Date): Promise<MergedPull[] | null>;
}

/** The earliest time someone other than the author acted, not after the merge. */
export function firstOther(
  author: string | null,
  mergedAt: string,
  acts: { by: string | null; at: string | null }[],
): string | null {
  const times = acts
    .filter((a) => a.by !== null && a.by !== author && a.at !== null && a.at <= mergedAt)
    .map((a) => a.at as string)
    .sort();
  return times[0] ?? null;
}
