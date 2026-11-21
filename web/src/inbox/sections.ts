import type { CodePlatformKind, PullItem } from "../../../src/shared/index.js";

type PlatformPulls = {
  platform: CodePlatformKind;
  host: string;
  linked: boolean;
  failed: boolean;
  more: boolean;
  pulls: PullItem[];
};
export type InboxAnswer = { platforms: PlatformPulls[] };
export type Row = PullItem & { host: string };

export type SectionId = "review" | "approved" | "returned" | "merged" | "drafts" | "waiting";
type Section = { id: SectionId; title: string; empty: string };

const SECTIONS: readonly Section[] = [
  { id: "review", title: "Needs your review", empty: "Nothing is waiting on your review." },
  { id: "approved", title: "Approved", empty: "None of yours is approved and open." },
  { id: "returned", title: "Returned to you", empty: "No reviewer asked you for changes." },
  { id: "merged", title: "Merged this week", empty: "Nothing of yours merged in the last 7 days." },
  { id: "drafts", title: "Drafts", empty: "You have no open drafts." },
  { id: "waiting", title: "Waiting for review", empty: "None of yours is waiting on a reviewer." },
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
  answer.platforms.flatMap((p) => p.pulls.map((pull) => ({ ...pull, host: p.host })));

export function inboxSections(rows: Row[], f: Filters) {
  const by = new Map<SectionId, Row[]>(SECTIONS.map((s) => [s.id, []]));
  for (const r of rows) {
    const id = sectionOf(r);
    if (id && matches(r, f)) by.get(id)?.push(r);
  }
  return SECTIONS.map((s) => ({ ...s, rows: by.get(s.id) ?? [] }));
}

/** Every repository with a pull in the inbox, by its platform host. */
export const reposOf = (rows: Row[]) =>
  [...new Set(rows.map((r) => `${r.host}/${r.repo}`))].sort((a, b) => a.localeCompare(b));
