// What the daily reconciliation (src/reconcile.ts) reads of an enrolled
// repository: its pull requests as the platform has them now, so a close or
// an open state a webhook missed is filled in. Read as the bot or the
// enrolling account's link; nothing is written to the platform.

/** One page of a listing: as many as the platform answers in one call. */
export const RECONCILE_PER_PAGE = 100;

type PullState = "open" | "closed" | "merged";

export type ReconciledPull = {
  number: number;
  title: string;
  author: string | null;
  authorId: string | null;
  draft: boolean;
  state: PullState;
  openedAt: Date | null;
  updatedAt: Date | null;
  /** When it was merged, or closed; null while open. */
  closedAt: Date | null;
};

export type ReconcileListing = {
  pulls: ReconciledPull[];
  /** True when the page cap stopped the listing before its end. */
  more: boolean;
};

export interface RepoReconcile {
  /** Closed or merged, changed since, newest change first, at most `pages` pages; null when the platform failed or refused. */
  closedSince(
    token: string,
    fullName: string,
    since: Date,
    pages: number,
  ): Promise<ReconcileListing | null>;
  /** Open now, at most `pages` pages; null when the platform failed or refused. */
  open(token: string, fullName: string, pages: number): Promise<ReconcileListing | null>;
  /** One pull request; `missing` when the platform has none of that number, null when it failed or refused. */
  one(token: string, fullName: string, number: number): Promise<ReconciledPull | "missing" | null>;
}

/** A time the platform wrote, or null when it is missing or not one. */
export function timeOf(text: unknown): Date | null {
  if (typeof text !== "string" || !text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
