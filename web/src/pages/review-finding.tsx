import { useState } from "react";
import type { Severity, Verification } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { symbolsOf } from "../impact/select.js";
import type { Impact } from "../impact/use-impact.js";
import { Link } from "../router.js";

// A finding as an event on the review's timeline: what it says, where, and
// the code it quotes. Every text is plain text: findings quote untrusted code.

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
};

const SEV = {
  critical: { label: "Critical", cls: "badge-err" },
  warning: { label: "Warning", cls: "badge-warn" },
  suggestion: { label: "Suggestion", cls: "" },
} as const;

export function FindingEvent(props: {
  f: Finding;
  impact: Impact;
  focused: boolean;
  onImpact: () => void;
}) {
  const { f } = props;
  const reached = props.impact.state === "ready" ? symbolsOf(props.impact.view.symbols, f) : [];
  const uses = reached.reduce((n, s) => n + s.useCount, 0);
  const [open, setOpen] = useState(false);
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
  const lines =
    f.lineStart === null
      ? ""
      : f.lineEnd && f.lineEnd !== f.lineStart
        ? `L${f.lineStart}–${f.lineEnd}`
        : `L${f.lineStart}`;
  const sev = SEV[f.severity];
  return (
    <li className={`event finding${props.focused ? " is-focused" : ""}`}>
      <span className={`event-mark sev-${f.severity}`} aria-hidden="true" />
      <div className="event-body">
        <div className="event-meta">
          <span>Finding</span>
          <span className={`badge ${sev.cls}`}>{sev.label}</span>
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
          {f.code && <pre className="codeblock">{f.code}</pre>}
        </div>
        <div className="event-actions">
          <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Details"}
          </button>
          {reached[0] && (
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={props.focused}
              onClick={props.onImpact}
            >
              Reaches {uses} use{uses === 1 ? "" : "s"} of {reached[0].name}
              {reached.length > 1 ? ` and ${reached.length - 1} more` : ""}
            </button>
          )}
        </div>
        {open && (
          <div className="finding-body">
            <p className="m-0 pre-wrap">{f.body}</p>
            {f.suggestion && (
              <div>
                <div className="caps finding-label">Suggestion</div>
                <p className="m-0 pre-wrap">{f.suggestion}</p>
              </div>
            )}
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
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!reason.trim() || state === "saving"}
                    onClick={remember}
                  >
                    Remember
                  </button>
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
