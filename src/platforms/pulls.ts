import type { PullItem, PullRole } from "../shared/index.js";

/** A pull request as a platform lists it, before the account's own reviews say anything of it. */
export type PlatformPull = Omit<PullItem, "verdict" | "unread" | "unreadReason" | "stack"> & {
  /** Its branch names, which stack it; null when its head is in a fork. */
  branches: { head: string; base: string } | null;
};

export type PullListing = {
  pulls: PlatformPull[];
  /** True when an open list held more than one request reads. */
  more: boolean;
};

export type ListedPull = Omit<PlatformPull, "roles">;

/** At most this many labels per pull request, each cut to MAX_LABEL characters. */
export const MAX_LABELS = 20;
const MAX_LABEL = 100;
export const labelsOf = (names: readonly string[]) =>
  names.slice(0, MAX_LABELS).map((n) => n.slice(0, MAX_LABEL));

export const OPEN_PER_LIST = 50;
export const MERGED_PER_LIST = 20;
const MERGED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export const mergedSince = (now: number) => new Date(now - MERGED_WITHIN_MS);

/** One item per pull, carrying every role it was listed under, newest change first. */
export function withRoles(lists: { role: PullRole; pulls: ListedPull[] }[]): PlatformPull[] {
  const byId = new Map<string, PlatformPull>();
  for (const { role, pulls } of lists) {
    for (const p of pulls) {
      const seen = byId.get(p.id);
      if (!seen) byId.set(p.id, { ...p, roles: [role] });
      else if (!seen.roles.includes(role)) seen.roles.push(role);
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** What a search asks a platform for: words, or a number in one repository or in any. */
export type PullSearch = { text: string } | { repo: string | null; number: number };

/** At most this many pull requests per platform and search. */
export const MAX_SEARCHED = 20;
