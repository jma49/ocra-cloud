// The pull requests opened last in this browser, newest first, for the
// command menu to offer before anything is typed. Only paths and titles the
// console already showed are kept.

const KEY = "ocra.recent-pulls";
const KEEP = 5;

export type RecentPull = { to: string; title: string; ref: string };

export function recentPulls(): RecentPull[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(kept)
      ? kept.filter(
          (p): p is RecentPull =>
            typeof p?.to === "string" &&
            p.to.startsWith("/pull/") &&
            typeof p.title === "string" &&
            typeof p.ref === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberPull(pull: RecentPull): void {
  const list = [pull, ...recentPulls().filter((p) => p.to !== pull.to)].slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage refused (private window): the menu just has nothing recent.
  }
}

export function forgetRecentPulls(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept to forget.
  }
}
