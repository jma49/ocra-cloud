import type { Severity } from "../../../src/shared/index.js";
import { Markdown } from "../markdown.js";
import { SeverityBadge } from "../severity.js";

// A review comment as the platform draws it: Markdown, with its HTML comments
// and suggestion blocks out of sight (the suggestions are drawn under it).
// ocra's own comment of a finding leads with a line of the finding's title,
// severity and notes, which is drawn as a head rather than read as text.

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

type FindingHead = { title: string; severity: Severity; notes: string[] };

/** ocra's head line: a mark, the title in bold, then the severity and notes between middle dots. */
function findingHead(line: string): FindingHead | null {
  const parts = line.split(" · ");
  const at = parts.findIndex((p) => SEVERITIES.includes(p));
  if (at < 1) return null;
  const lead = parts.slice(0, at).join(" · ");
  const open = lead.indexOf("**");
  if (open < 0 || !lead.endsWith("**") || lead.length < open + 5) return null;
  return {
    title: lead.slice(open + 2, -2),
    severity: parts[at] as Severity,
    notes: parts.slice(at + 1),
  };
}

export function ThreadBody(props: { body: string }) {
  const source = props.body.replace(/\r\n?/g, "\n");
  const text = withoutSuggestions(withoutHtmlComments(source)).trim();
  const lineEnd = text.indexOf("\n");
  const first = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const head = source.includes(FINDING_MARK) ? findingHead(first) : null;
  const rest = head ? text.slice(first.length).trim() : text;
  if (!head && !rest) return null;
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
      {rest && <Markdown links text={rest} />}
    </div>
  );
}
