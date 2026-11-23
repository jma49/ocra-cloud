import { httpsLink, inline, unmentioned } from "./description-draft.js";
import type { RangePull } from "./platforms/releases.js";
import {
  MAX_RELEASE_BODY_CHARS,
  RELEASE_SECTIONS,
  type ReleasePullView,
  type ReleaseReviewVerdict,
  type ReleaseSection,
} from "./shared/index.js";

// A release's notes from the pull requests merged in its range, without a
// model: each title's Conventional Commit type picks its section, `!` or a
// `BREAKING CHANGE:` footer makes it breaking. Titles may be anyone's text,
// so each goes through `inline` (no HTML, Markdown escaped, no mentions),
// and an author's login through `unmentioned`: credited, never pinged.

const TITLE = /^([A-Za-z]+)(\([^()\r\n]*\))?(!)?:\s*(\S.*)$/s;

const SECTION_OF: Record<string, ReleaseSection> = {
  feat: "added",
  fix: "fixed",
  perf: "performance",
  refactor: "hidden",
  chore: "hidden",
  ci: "hidden",
  build: "hidden",
  test: "hidden",
  style: "hidden",
};

const HEADING: Record<ReleaseSection, string> = {
  breaking: "Breaking changes",
  added: "Added",
  fixed: "Fixed",
  performance: "Performance",
  other: "Other changes",
  hidden: "Maintenance",
};

const VERDICT: Record<ReleaseReviewVerdict, string> = {
  approved: "approved",
  approved_with_comments: "approved with comments",
  minor_issues: "minor issues",
  significant_concerns: "significant concerns",
};

type Parsed = { type: string | null; scope: string | null; subject: string; breaking: boolean };

export function parseTitle(title: string): Parsed {
  const m = TITLE.exec(title.trim());
  if (!m) return { type: null, scope: null, subject: title, breaking: false };
  const scope = m[2] ? m[2].slice(1, -1).trim() : "";
  return {
    type: (m[1] ?? "").toLowerCase(),
    scope: scope === "" ? null : scope,
    subject: m[4] ?? title,
    breaking: m[3] === "!",
  };
}

/** The pull request's place in the notes; `review` is the account's own, when asked for. */
export function pullView(pull: RangePull, review: ReleasePullView["review"]): ReleasePullView {
  const parsed = parseTitle(pull.title);
  const breaking = parsed.breaking || pull.breakingNote;
  const section: ReleaseSection = breaking
    ? "breaking"
    : parsed.type
      ? (SECTION_OF[parsed.type] ?? "other")
      : "other";
  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    author: pull.author,
    mergedAt: pull.mergedAt,
    type: parsed.type,
    breaking,
    section,
    review,
  };
}

export type NotesInput = {
  pulls: readonly ReleasePullView[];
  /** `#` on GitHub, `!` on GitLab. */
  marker: "#" | "!";
  compareUrl: string;
  from: string;
  to: string;
  truncated: boolean;
  showHidden: boolean;
};

function line(p: ReleasePullView, marker: string): string {
  const { scope, subject } = parseTitle(p.title);
  const text = `${scope ? `**${inline(scope)}:** ` : ""}${inline(subject)}`;
  const link = httpsLink(p.url);
  const ref = link ? `[${marker}${p.number}](${link})` : `${marker}${p.number}`;
  const credit = p.author ? `, by ${unmentioned(`@${p.author}`)}` : "";
  const review = p.review
    ? `; ocra: ${p.review.verdict ? VERDICT[p.review.verdict] : "reviewed"}, ${p.review.findings} ${p.review.findings === 1 ? "finding" : "findings"}`
    : "";
  return `- ${text} (${ref}${credit}${review})`;
}

/** The notes in Markdown, cut to what a release takes. */
export function releaseNotes(input: NotesInput): string {
  const blocks: string[] = [];
  for (const section of RELEASE_SECTIONS) {
    if (section === "hidden" && !input.showHidden) continue;
    const listed = input.pulls.filter((p) => p.section === section);
    if (listed.length === 0) continue;
    blocks.push(
      `### ${HEADING[section]}\n\n${listed.map((p) => line(p, input.marker)).join("\n")}`,
    );
  }
  if (blocks.length === 0) blocks.push("No pull requests were merged in this range.");
  if (input.truncated) {
    blocks.push(`This draft lists the first ${input.pulls.length} pull requests of the range.`);
  }
  const range = `${inline(input.from)}...${inline(input.to)}`;
  const compare = httpsLink(input.compareUrl);
  blocks.push(`**Full changes:** ${compare ? `[${range}](${compare})` : range}`);
  const body = blocks.join("\n\n");
  return body.length > MAX_RELEASE_BODY_CHARS ? cut(body) : body;
}

/** Whole lines only, so no escape or link is cut in half. */
function cut(body: string): string {
  const note = "\n\n…the rest did not fit in a release's notes.";
  const room = MAX_RELEASE_BODY_CHARS - note.length;
  const end = body.lastIndexOf("\n", room);
  return `${body.slice(0, end > 0 ? end : room)}${note}`;
}
