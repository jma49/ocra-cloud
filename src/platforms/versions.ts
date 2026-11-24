import type { SinceDiff } from "./since.js";

// A pull request's versions as its platform still lists them, read as the
// user for one request; nothing read is kept. The heads ocra's webhooks
// kept (src/pull-versions/hooks.ts) are added to them by the caller.

export type PlatformVersion = {
  head: string;
  /** When it was pushed; null when the platform says only when its commit was made. */
  pushedAt: Date | null;
  /** What orders the platform's heads: the push time, else the commit's. */
  at: Date;
  /** true when a force push or rebase made it; null when the platform does not say. */
  rewrite: boolean | null;
};

export type PlatformVersions = {
  versions: PlatformVersion[];
  /** Whether the list starts at the pull request's first push. */
  fromStart: boolean;
  /** Whether the platform names every force push, so a head it does not name was a fast forward. */
  namesRewrites: boolean;
};

export interface PullVersions {
  /** null when the platform failed or the user cannot read the pull request. */
  list(token: string, fullName: string, number: number): Promise<PlatformVersions | null>;
  /**
   * The files that differ between two commits' trees, whatever their
   * history: for a force push or rebase, where one is no ancestor of the
   * other. null when the platform failed or answered too much.
   */
  trees(token: string, fullName: string, from: string, to: string): Promise<SinceDiff | null>;
}
