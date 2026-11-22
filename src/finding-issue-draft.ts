import type { Row } from "./db/scoped.js";
import { httpsLink, inline, unmentioned } from "./description-draft.js";
import { repoFilePath } from "./platforms/fix.js";
import type { CodePlatform } from "./platforms/platform.js";
import { pullPageUrl, type ReviewPull } from "./review-pull.js";
import {
  type FindingIssueRequest,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
  type Severity,
} from "./shared/index.js";

// An issue drafted from a finding, without a model: its severity and title,
// where it is at the reviewed head, its text, and the pull request it was
// found on. The finding's text came from the reviewed change through the
// CLI, so it may be hostile: each line goes through `inline` (no HTML, no
// Markdown syntax), and every @ is broken so no mention reaches anyone.

const SEVERITY: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  suggestion: "Suggestion",
};

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CUT = "…";

/** Lines of the finding's text, each as `inline` writes it, with its paragraphs kept. */
function paragraphs(text: string): string {
  return text
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((line) => inline(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The issue's title: one line of plain text, no control characters, at most MAX_ISSUE_TITLE_CHARS. */
function issueTitle(finding: Pick<Row<"findings">, "severity" | "title">): string {
  const line = unmentioned(
    `${SEVERITY[finding.severity]}: ${finding.title}`
      .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const chars = [...line];
  return chars.length > MAX_ISSUE_TITLE_CHARS
    ? `${chars.slice(0, MAX_ISSUE_TITLE_CHARS - 1).join("")}${CUT}`
    : line;
}

/** The finding's lines in the file at the reviewed head, on the platform; null when there is no safe address. */
function fileLink(platform: CodePlatform, pull: ReviewPull, f: Row<"findings">): string | null {
  const path = repoFilePath(f.file);
  if (!path || !SHA.test(pull.head)) return null;
  const segments = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const blob = platform.kind === "gitlab" ? "-/blob" : "blob";
  const start = f.lineStart;
  const end = f.lineEnd !== null && start !== null && f.lineEnd > start ? f.lineEnd : null;
  const anchor =
    start === null
      ? ""
      : end === null
        ? `#L${start}`
        : platform.kind === "gitlab"
          ? `#L${start}-${end}`
          : `#L${start}-L${end}`;
  return httpsLink(
    `${platform.url}/${segments(pull.repo)}/${blob}/${pull.head}/${segments(path)}${anchor}`,
  );
}

const lines = (f: Row<"findings">) =>
  f.lineStart === null
    ? ""
    : f.lineEnd !== null && f.lineEnd > f.lineStart
      ? ` L${f.lineStart}–${f.lineEnd}`
      : ` L${f.lineStart}`;

const link = (label: string, url: string | null) => (url ? `[${label}](${url})` : label);

/** The finding's text cut to `max` characters at a line or word break, never inside an escape. */
function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(0, max - CUT.length));
  const at = Math.max(room.lastIndexOf("\n"), room.lastIndexOf(" "));
  return `${room.slice(0, Math.max(at, 0)).trimEnd()}${CUT}`;
}

/** The issue ocra drafts from a finding of a review of `pull`, on `platform`. */
export function issueDraft(
  platform: CodePlatform,
  pull: ReviewPull,
  f: Row<"findings">,
): FindingIssueRequest {
  const where = `${inline(f.file)}${lines(f)}`;
  const pullLabel = inline(`${pull.repo}#${pull.number}`);
  const meta = [
    `**${SEVERITY[f.severity]}**`,
    ...(f.category ? [inline(f.category)] : []),
    ...(f.verification ? [f.verification] : []),
  ].join(" · ");
  const head = `Found by ocra in its review of ${link(pullLabel, httpsLink(pullPageUrl(platform, pull)))} at \`${pull.head.slice(0, 12)}\`, in ${link(where, fileLink(platform, pull, f))}.`;
  const suggestion = f.suggestion ? paragraphs(f.suggestion) : "";
  const footer = "_Opened from a finding of ocra's review; its text is quoted as plain text._";
  const fixed = [meta, head, suggestion && `**Suggestion**\n\n${suggestion}`, footer];
  const room = MAX_ISSUE_BODY_CHARS - fixed.join("\n\n").length - 4;
  const body = cutTo(paragraphs(f.body), Math.max(0, room));
  return {
    title: issueTitle(f),
    body: [meta, head, body, ...fixed.slice(2)].filter((b) => b !== "").join("\n\n"),
  };
}
