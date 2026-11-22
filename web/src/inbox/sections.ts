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

export type SectionId = "review" | "approved" | "returned" | "merged" | "drafts" | "waiting";
type Section = { id: SectionId; title: string };

const SECTIONS: readonly Section[] = [
  { id: "review", title: "Needs your review" },
  { id: "approved", title: "Approved" },
  { id: "returned", title: "Returned to you" },
  { id: "merged", title: "Merged this week" },
  { id: "drafts", title: "Drafts" },
  { id: "waiting", title: "Waiting for review" },
];

/** Each pull belongs to one section; null when it waits on no one (a draft asking your review). */
export function sectionOf(p: PullItem): SectionId | null {
  const mine = p.roles.includes("author");
  if (p.state === "merged") return mine ? "merged" : null;
  if (p.roles.includes("reviewer") && !p.draft && !mine) return "review";
  if (!mine) return null;
  if (p.draft) return "drafts";
  if (p.review === "changes_requested") return "returned";
  if (p.review === "approved") return "approved";
  return "waiting";
}

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

export type ShownSection = {
  key: string;
  title: string;
  rows: Row[];
  view?: PullView;
};

/** The fixed sections, then the account's own, each with its rows. */
export function inboxSections(rows: Row[], f: Filters, views: PullView[] = []): ShownSection[] {
  const by = new Map<SectionId, Row[]>(SECTIONS.map((s) => [s.id, []]));
  for (const r of rows) {
    const id = sectionOf(r);
    if (id && matches(r, f)) by.get(id)?.push(r);
  }
  return [
    ...SECTIONS.map((s) => ({
      key: s.id,
      title: s.title,
      rows: by.get(s.id) ?? [],
    })),
    ...views
      .filter((view) => !view.hidden)
      .map((view) => ({
        key: `view:${view.id}`,
        title: view.name,
        rows: rows.filter((r) => matchesView(r, view.filters) && matches(r, f)),
        view,
      })),
  ];
}

/** Every repository with a pull in the inbox, by its platform host. */
export const reposOf = (rows: Row[]) =>
  [...new Set(rows.map((r) => `${r.host}/${r.repo}`))].sort((a, b) => a.localeCompare(b));

/** Whether a pull belongs in an account's own section: the server's rule (src/shared/pulls.ts). */
export const matchesView = (r: Row, f: PullFilters): boolean =>
  matchesPullFilters(r, f, Date.now());
