import { useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  type FindingIssueView,
  type FixProposalView,
  type PlatformDismissal,
  replacementLines,
  type Severity,
  type Verification,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { FindingText } from "../finding-text.js";
import { FixDiff } from "../fixes/fix-diff.js";
import { CommitFixNote } from "../fixes/fix-proposal.js";
import { useCommitFix } from "../fixes/use-commit-fix.js";
import { ago } from "../format.js";
import { symbolsOf } from "../impact/select.js";
import type { Impact } from "../impact/use-impact.js";
import { Link } from "../router.js";
import { SeverityBadge } from "../severity.js";
import { CodeBlock } from "../ui.js";
import { FindingIssue } from "./finding-issue.js";

// A finding as an event on the review's timeline: what it says, where, and
// the code it quotes. Findings quote untrusted code: what a model wrote is
// drawn as Markdown without links, everything else as plain text.

export type Finding = {
  id: string;
  fingerprint: string;
  reviewer: string;
  severity: Severity;
  category: string | null;
  verification: Verification | null;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  body: string;
  suggestion: string | null;
  code: string | null;
  redacted: boolean;
  truncated: boolean;
  status: "open" | "fixed" | "dismissed";
  /** The lines the fix replaces at the reviewed head, and what with; null without one. */
  fix: { startLine: number; endLine: number; replacement: string } | null;
  /** The issue opened from it in the reviewed repository; null before one is. */
  issue: FindingIssueView | null;
  /** What people did to its comment's thread on the platform; null when nothing is on record. */
  platformDismissal: PlatformDismissal | null;
};

/** What happened to the finding's thread on the platform: who resolved or reopened it, and the reply kept as the reason. */
export function PlatformThread(props: { d: PlatformDismissal }) {
  const { d } = props;
  const notes = [
    d.redacted && "a secret-looking string was replaced",
    d.truncated && "cut short",
  ].filter(Boolean);
  return (
    <div>
      <div className="quiet-label finding-label">Thread on the platform</div>
      {d.state !== null && (
        <p className="m-0 small muted">
          {d.state === "resolved" ? "Resolved" : "Reopened"}
          {d.by && ` by ${d.by}`}
          {d.at && `, ${ago(d.at)}`}
        </p>
      )}
      {d.reason !== null && (
        <>
          <p className="m-0 pre-wrap">{d.reason}</p>
          <p className="m-0 small subtle">
            {d.reasonBy ?? "A reply"}
            {d.reasonAt && `, ${ago(d.reasonAt)}`}
            {notes.length > 0 && ` · ${notes.join(", ")}`}
          </p>
        </>
      )}
    </div>
  );
}

export function FindingEvent(props: {
  f: Finding;
  impact: Impact;
  focused: boolean;
  /** The finding the page's keys act on. */
  current: boolean;
  row: number;
  /** Whether its details show. */
  open: boolean;
  onToggle: () => void;
  onImpact: () => void;
  /** The review names its pull request, so a fix can be committed to it. */
  canFix: boolean;
  /** The lines its fix replaces at the reviewed head; null when they could not be read. */
  before: FixProposalView["before"];
}) {
  const { f } = props;
  const reached = props.impact.state === "ready" ? symbolsOf(props.impact.view.symbols, f) : [];
  const uses = reached.reduce((n, s) => n + s.useCount, 0);
  const { open } = props;
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const remember = async () => {
    setState("saving");
    try {
      await api("/memory", { method: "POST", body: JSON.stringify({ findingId: f.id, reason }) });
      setState("saved");
    } catch {
      setState("error");
    }
  };
  const { state: fixed, commit: commitFix } = useCommitFix(f.id);
  const fixable = f.fix !== null && props.canFix && f.status !== "fixed" && fixed !== "done";
  const lines =
    f.lineStart === null
      ? ""
      : f.lineEnd && f.lineEnd !== f.lineStart
        ? `L${f.lineStart}–${f.lineEnd}`
        : `L${f.lineStart}`;
  return (
    <li
      className={`event finding${props.focused ? " is-focused" : ""}${props.current ? " is-current" : ""}`}
      data-row={props.row}
    >
      <span className={`event-mark sev-${f.severity}`} aria-hidden="true" />
      <div className="event-body">
        <div className="event-meta">
          <span>Finding</span>
          <SeverityBadge severity={f.severity} />
          <span className="subtle">
            {f.reviewer}
            {f.verification ? ` · ${f.verification}` : ""}
            {f.redacted ? " · redacted" : ""}
            {f.truncated ? " · cut" : ""}
          </span>
        </div>
        <p className="event-text finding-title">{f.title}</p>
        <div className="code-card">
          <div className="code-card-head">
            <span className="mono">{f.file}</span>
            <span className="mono subtle">{lines}</span>
          </div>
          {f.code && (!f.fix || props.before === null) && (
            <CodeBlock label={`Code at ${f.file}`}>{f.code}</CodeBlock>
          )}
          {f.fix && (
            <FixDiff
              fix={{ ...f.fix, before: props.before, after: replacementLines(f.fix.replacement) }}
            />
          )}
        </div>
        <div className="event-actions">
          <Button type="button" variant="outline" size="sm" onClick={props.onToggle}>
            {open ? "Hide" : "Details"}
          </Button>
          {reached[0] && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={props.focused}
              onClick={props.onImpact}
            >
              Reaches {uses} use{uses === 1 ? "" : "s"} of {reached[0].name}
              {reached.length > 1 ? ` and ${reached.length - 1} more` : ""}
            </Button>
          )}
          {fixable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fixed === "sending"}
              onClick={commitFix}
            >
              Commit fix
            </Button>
          )}
          {(f.status === "fixed" || fixed === "done") && <Status tone="ok">Fixed</Status>}
          {props.canFix && <FindingIssue findingId={f.id} issue={f.issue} />}
        </div>
        <CommitFixNote state={fixed} />
        {open && (
          <div className="finding-body">
            <FindingText body={f.body} suggestion={f.suggestion} />
            {f.platformDismissal && <PlatformThread d={f.platformDismissal} />}
            <div className="inline-form">
              {state === "saved" ? (
                <span className="small">
                  Remembered: later reviews of this repository stop reporting it.{" "}
                  <Link to="/memory">Manage memory</Link>
                </span>
              ) : (
                <>
                  <input
                    className="input"
                    aria-label="Why the team accepts this"
                    placeholder="Why the team accepts this (shown in later reports)"
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!reason.trim() || state === "saving"}
                    onClick={remember}
                  >
                    Remember
                  </Button>
                  {state === "error" && <span className="error">Could not remember it.</span>}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
