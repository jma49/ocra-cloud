import type { PullItem, PullRole } from "../shared/index.js";

export type PullListing = {
  pulls: PullItem[];
  /** True when an open list held more than one request reads. */
  more: boolean;
};

export type ListedPull = Omit<PullItem, "roles">;

export const OPEN_PER_LIST = 50;
export const MERGED_PER_LIST = 20;
const MERGED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export const mergedSince = (now: number) => new Date(now - MERGED_WITHIN_MS);

/** One item per pull, carrying every role it was listed under, newest change first. */
export function withRoles(lists: { role: PullRole; pulls: ListedPull[] }[]): PullItem[] {
  const byId = new Map<string, PullItem>();
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
