import { SEVERITIES } from "@open-cr-agent/cloud-contract";
import type { Row } from "./db/scoped.js";
import { DESCRIPTION_END, DESCRIPTION_START, type LinkedTaskView } from "./shared/index.js";

// The section of a pull request's description that ocra drafts from its
// stored review, without a model. Every string from the review (the CLI
// wrote it from the reviewed change, so it may be hostile) goes through
// `inline`: one line, no HTML (& < > as entities, so it can neither add a
// tag nor fake a marker), and Markdown's inline syntax escaped, so a title
// reads as the text it is and mentions no one.

/** What a list in the section shows of each group's files, and of each severity's findings. */
const MAX_LISTED = 10;
const SEPARATOR = "\n\n";

type Severity = (typeof SEVERITIES)[number];
const SEVERITY: Record<Severity, [string, string]> = {
  critical: ["critical", "critical"],
  warning: ["warning", "warnings"],
  suggestion: ["suggestion", "suggestions"],
};

const VERDICT: Record<NonNullable<Row<"reviews">["verdict"]>, string> = {
  approved: "ocra approved this change",
  approved_with_comments: "ocra approved this change with comments",
  minor_issues: "ocra found minor issues",
  significant_concerns: "ocra found significant concerns",
};

/** One line of the review's text, safe to embed anywhere in a Markdown line. */
export function inline(text: string): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]()#|~!@:]/g, "\\$&");
}

/** An address for a Markdown link: https only, with nothing that would end the link early. */
export function httpsLink(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return u.href.replace(/[()<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

const more = (shown: number, all: number) => (all > shown ? `, and ${all - shown} more` : "");

export type DraftInput = {
  review: Row<"reviews">;
  walkthrough: Row<"reviewWalkthroughs"> | undefined;
  /** The review's shared findings; empty unless the account shares them. */
  findings: readonly Pick<Row<"findings">, "severity" | "title" | "status">[];
  sharing: boolean;
  current: boolean;
};

/** ocra's section, markers included. */
export function draftSection(input: DraftInput): string {
  const { review, walkthrough } = input;
  const blocks: string[] = [];
  const verdict = review.verdict ? `${VERDICT[review.verdict]}.` : "ocra reviewed this change.";
  const overview = walkthrough ? ` ${inline(walkthrough.overview)}` : "";
  blocks.push(`### Summary${SEPARATOR}${verdict}${overview}`);
  if (walkthrough && walkthrough.groups.length > 0) {
    const lines = walkthrough.groups.map((g) => {
      const files = g.files.slice(0, MAX_LISTED).map(inline).join(", ");
      const note = g.note.trim() ? `: ${inline(g.note)}` : "";
      const listed = files ? ` (${files}${more(MAX_LISTED, g.files.length)})` : "";
      return `- **${inline(g.title)}**${note}${listed}`;
    });
    blocks.push(`### Changes${SEPARATOR}${lines.join("\n")}`);
  }
  const tasks = (review.linkedTasks ?? []).filter((t): t is NonNullable<LinkedTaskView> => !!t);
  if (tasks.length > 0) {
    const lines = tasks.map((t) => {
      const url = httpsLink(t.url);
      const key = url ? `[${inline(t.key)}](${url})` : inline(t.key);
      const title = input.sharing && t.title ? `: ${inline(t.title)}` : "";
      const state = t.state ? ` (${t.state})` : "";
      return `- ${key}${title}${state}`;
    });
    blocks.push(`### Linked tasks${SEPARATOR}${lines.join("\n")}`);
  }
  blocks.push(`### Risk notes${SEPARATOR}${riskNotes(input)}`);
  const head = `\`${review.prHeadSha?.slice(0, 12) ?? ""}\``;
  const which = input.current ? "the current head" : "an earlier head, not the current one";
  blocks.push(`_Drafted by ocra from its review of ${head}, ${which}._`);
  return [DESCRIPTION_START, ...blocks, DESCRIPTION_END].join(SEPARATOR);
}

/** By severity: the open findings' titles when the account shares them, else the review's counts. */
function riskNotes({ review, findings, sharing }: DraftInput): string {
  const counts: Record<Severity, number> = {
    critical: review.critical,
    warning: review.warning,
    suggestion: review.suggestion,
  };
  if (sharing && findings.length > 0) {
    const lines = SEVERITIES.flatMap((s) => {
      const titles = findings.filter((f) => f.severity === s && f.status === "open");
      if (titles.length === 0) return [];
      const listed = titles.slice(0, MAX_LISTED).map((f) => `  - ${inline(f.title)}`);
      const rest = titles.length > MAX_LISTED ? [`  - and ${titles.length - MAX_LISTED} more`] : [];
      return [`- ${plural(titles.length, SEVERITY[s])}`, ...listed, ...rest];
    });
    return lines.length > 0 ? lines.join("\n") : "No open findings.";
  }
  if (SEVERITIES.every((s) => counts[s] === 0)) return "No findings.";
  return `${SEVERITIES.map((s) => plural(counts[s], SEVERITY[s])).join(", ")}.`;
}

/**
 * The body with `section` in place of ocra's section, the last one between
 * the markers, or after the body when it has none: the user's own text is
 * kept as it is.
 */
export function withSection(body: string, section: string): string {
  const end = body.lastIndexOf(DESCRIPTION_END);
  const start = end < 0 ? -1 : body.lastIndexOf(DESCRIPTION_START, end);
  if (start >= 0) {
    return body.slice(0, start) + section + body.slice(end + DESCRIPTION_END.length);
  }
  const own = body.trimEnd();
  return own ? `${own}${SEPARATOR}${section}\n` : `${section}\n`;
}
