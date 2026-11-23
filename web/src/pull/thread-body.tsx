import type { Severity } from "../../../src/shared/index.js";
import { Markdown } from "../markdown.js";
import { SeverityBadge } from "../severity.js";

// A review comment as the platform draws it: Markdown, with its HTML comments
// and suggestion blocks out of sight (the suggestions are drawn under it).
// ocra's own comment of a finding leads with the finding's title, severity
// and notes, which are drawn as a head rather than read as text, and ends
// with the evidence it folds.

const FINDING_MARK = "<!-- ocra:finding ";
const SEVERITIES: readonly string[] = ["critical", "warning", "suggestion"];

/** The text without its HTML comments; one left open hides the rest, as on the platform. */
function withoutHtmlComments(text: string): string {
  let out = "";
  for (let at = 0; ; ) {
    const open = text.indexOf("<!--", at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return out;
    at = close + 3;
  }
}

const SUGGESTION_FENCE = /^ {0,3}(`{3,}|~{3,})suggestion/;

/** The text without its suggestion blocks, each to the fence that closes it. */
function withoutSuggestions(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const opens = SUGGESTION_FENCE.exec(line)?.[1];
    if (opens) fence = opens;
    else kept.push(line);
  }
  return kept.join("\n");
}

type FindingHead = { title: string; severity: Severity; notes: string[]; lines: number };

/** The title between the line's first `**` and the `**` that ends `lead`. */
function boldTitle(lead: string): string | null {
  const open = lead.indexOf("**");
  if (open < 0 || !lead.endsWith("**") || lead.length < open + 5) return null;
  return lead.slice(open + 2, -2);
}

/** ocra's head as it writes it now: the title on a line ended by a backslash, the severity and notes under it. */
function twoLineHead(first: string, second: string): FindingHead | null {
  if (!first.endsWith("\\")) return null;
  const title = boldTitle(first.slice(0, -1));
  const [severity = "", ...notes] = second.split(" · ");
  if (title === null || !SEVERITIES.includes(severity.toLowerCase())) return null;
  return { title, severity: severity.toLowerCase() as Severity, notes, lines: 2 };
}

/** ocra's head in comments posted earlier: a mark, the title in bold, then the severity and notes between middle dots. */
function oneLineHead(line: string): FindingHead | null {
  const parts = line.split(" · ");
  const at = parts.findIndex((p) => SEVERITIES.includes(p));
  if (at < 1) return null;
  const title = boldTitle(parts.slice(0, at).join(" · "));
  if (title === null) return null;
  return { title, severity: parts[at] as Severity, notes: parts.slice(at + 1), lines: 1 };
}

const EVIDENCE_OPEN = "<details><summary>Evidence</summary>";
const EVIDENCE_CLOSE = "</details>";

/** The text split at the folded evidence ocra ends a finding's comment with. */
function splitEvidence(text: string): { above: string; evidence: string } {
  const open = text.lastIndexOf(EVIDENCE_OPEN);
  if (open < 0 || !text.endsWith(EVIDENCE_CLOSE)) return { above: text, evidence: "" };
  return {
    above: text.slice(0, open).trim(),
    evidence: text.slice(open + EVIDENCE_OPEN.length, -EVIDENCE_CLOSE.length).trim(),
  };
}

/** A comment as it is drawn: ocra's head when it leads with one, its text, and the evidence it folds. */
export type Said = { head: FindingHead | null; text: string; evidence: string };

export function readComment(body: string): Said {
  const source = body.replace(/\r\n?/g, "\n");
  const text = withoutSuggestions(withoutHtmlComments(source)).trim();
  const [first = "", second = ""] = text.split("\n", 2);
  const head = source.includes(FINDING_MARK)
    ? (twoLineHead(first, second) ?? oneLineHead(first))
    : null;
  if (!head) return { head, text, evidence: "" };
  const below = text.split("\n").slice(head.lines).join("\n").trim();
  const { above, evidence } = splitEvidence(below);
  return { head, text: above, evidence };
}

export function ThreadBody(props: { said: Said }) {
  const { head, text } = props.said;
  if (!head && !text) return null;
  return (
    <div className="thread-body">
      {head && (
        <div className="thread-finding">
          <div className="thread-finding-title">
            <Markdown text={head.title} />
          </div>
          <div className="thread-finding-notes">
            <SeverityBadge severity={head.severity} />
            {head.notes.length > 0 && (
              <span className="subtle small">{head.notes.join(" · ")}</span>
            )}
          </div>
        </div>
      )}
      {text && <Markdown links text={text} />}
    </div>
  );
}

/** The facts behind ocra's finding, folded as on the platform. */
export function ThreadEvidence(props: { said: Said }) {
  if (!props.said.evidence) return null;
  return (
    <details className="thread-evidence">
      <summary className="subtle">
        <span className="fold" aria-hidden="true" />
        Evidence
      </summary>
      <Markdown text={props.said.evidence} />
    </details>
  );
}
