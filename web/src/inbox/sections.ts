import {
  type CodePlatformKind,
  matchesPullFilters,
  type PullFilters,
  type PullItem,
  type PullView,
} from "../../../src/shared/index.js";

type PlatformPulls = {
  platform: CodePlatformKind;
  host: string;
  linked: boolean;
  failed: boolean;
  more: boolean;
  pulls: PullItem[];
};
export type InboxAnswer = { platforms: PlatformPulls[] };
export type Row = PullItem & { host: string; platform: CodePlatformKind };

/** Open pull requests of others asking the user's review: the count the tab's title carries. */
export const reviewAsked = (rows: Row[]): number =>
  rows.filter(
    (r) =>
      r.state === "open" && !r.draft && r.roles.includes("reviewer") && !r.roles.includes("author"),
  ).length;

export type Filters = { text: string; repo: string };

const matches = (r: Row, f: Filters) => {
  if (f.repo && `${r.host}/${r.repo}` !== f.repo) return false;
  const needle = f.text.trim().toLowerCase();
  return (
    !needle || `${r.repo}#${r.number} ${r.title} ${r.author ?? ""}`.toLowerCase().includes(needle)
  );
};

export const rowsOf = (answer: InboxAnswer): Row[] =>
  answer.platforms.flatMap((p) =>
    p.pulls.map((pull) => ({ ...pull, host: p.host, platform: p.platform })),
  );

export type ShownSection = { key: string; title: string; rows: Row[]; view: PullView };

/** The views that are not hidden, in their order, each with the rows it matches. */
export function inboxSections(rows: Row[], f: Filters, views: PullView[]): ShownSection[] {
  return views
    .filter((view) => !view.hidden)
    .map((view) => ({
      key: `view:${view.id}`,
      title: view.name,
      rows: rows.filter((r) => matchesView(r, view.filters) && matches(r, f)),
      view,
    }));
}

/** Every repository with a pull in the inbox, by its platform host. */
export const reposOf = (rows: Row[]) =>
  [...new Set(rows.map((r) => `${r.host}/${r.repo}`))].sort((a, b) => a.localeCompare(b));

/** Whether a pull belongs in a section: the server's rule (src/shared/pulls.ts). */
export const matchesView = (r: Row, f: PullFilters): boolean =>
  matchesPullFilters(r, f, Date.now());
