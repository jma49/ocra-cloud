import { useMemo, useState } from "react";
import type { Severity, Verdict, Verification } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { time } from "../format.js";
import { Link } from "../router.js";
import { LoadError, Loading, PageHead, Seg, useLoad } from "../ui.js";

// One review and, when the account shares findings, its findings (ADR-0028).
// Every text is rendered as plain text: findings quote untrusted code.

type Finding = {
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
type Detail = {
  review: {
    id: string;
    runId: string;
    repo: string;
    source: string;
    verdict: Verdict | null;
    complete: boolean;
    critical: number;
    warning: number;
    suggestion: number;
    createdAt: string;
  };
  findings: Finding[];
};

const SEV_CLASS = { critical: "badge-err", warning: "badge-warn", suggestion: "" } as const;

export function ReviewDetail(props: { id: string }) {
  const { data, error, reload } = useLoad(
    () => api<Detail>(`/reviews/${encodeURIComponent(props.id)}`),
    [props.id],
  );
  const [severity, setSeverity] = useState<"all" | Finding["severity"]>("all");
  const byFile = useMemo(() => {
    const groups = new Map<string, Finding[]>();
    for (const f of data?.findings ?? []) {
      if (severity !== "all" && f.severity !== severity) continue;
      groups.set(f.file, [...(groups.get(f.file) ?? []), f]);
    }
    return [...groups.entries()];
  }, [data, severity]);

  if (error && !(error instanceof ApiError && error.status === 404)) {
    return (
      <>
        <PageHead title="Review" />
        <LoadError what="this review" error={error} retry={reload} />
      </>
    );
  }
  if (error) {
    return (
      <>
        <PageHead title="Review" />
        <div className="card empty-hero">
          <h3>Review not found</h3>
          <p>It may have passed the 90-day retention, or been deleted.</p>
          <Link to="/reviews" className="btn">
            Back to reviews
          </Link>
        </div>
      </>
    );
  }
  if (!data)
    return (
      <>
        <PageHead title="Review" />
        <Loading what="the review" />
      </>
    );
  const r = data.review;
  return (
    <>
      <PageHead
        title={`Review of ${r.repo}`}
        sub={`${time(r.createdAt)} · ${r.source} · run ${r.runId}`}
        actions={
          <span className="row-gap">
            <Link to="/reviews" className="btn">
              All reviews
            </Link>
            <a className="btn" href={`/api/reviews/${r.id}/export`} download>
              Download JSON
            </a>
          </span>
        }
      />
      <div className="stats stats-4">
        <div className="card stat">
          <div className="stat-label">Result</div>
          <div className="stat-value stat-word">
            {!r.complete ? "Incomplete" : (r.verdict ?? "–").replaceAll("_", " ")}
          </div>
        </div>
        {(["critical", "warning", "suggestion"] as const).map((k) => (
          <div className="card stat" key={k}>
            <div className="stat-label capitalize">{k}</div>
            <div className="stat-value">{r[k]}</div>
          </div>
        ))}
      </div>

      {data.findings.length === 0 ? (
        <div className="section card empty-hero">
          <h3>No findings stored for this review</h3>
          <p>
            Findings are kept only when you share them (Settings). Counts are always kept; turn
            sharing on to see findings of later reviews here.
          </p>
          <Link to="/settings" className="btn">
            Open settings
          </Link>
        </div>
      ) : (
        <div className="section">
          <div className="section-title">
            <span>
              {data.findings.length} finding{data.findings.length === 1 ? "" : "s"} in{" "}
              {byFile.length} file
              {byFile.length === 1 ? "" : "s"}
            </span>
            <Seg
              label="Severity"
              value={severity}
              options={[
                { value: "all", label: "All" },
                { value: "critical", label: "Critical" },
                { value: "warning", label: "Warning" },
                { value: "suggestion", label: "Suggestion" },
              ]}
              onChange={setSeverity}
            />
          </div>
          {byFile.map(([file, list]) => (
            <div className="card file-card" key={file}>
              <div className="card-head">
                <h3 className="mono">{file}</h3>
                <span className="subtle small">{list.length}</span>
              </div>
              {list.map((f) => (
                <FindingRow key={f.id} f={f} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function FindingRow(props: { f: Finding }) {
  const { f } = props;
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
  return (
    <div className="finding">
      <div className="finding-head">
        <span className={`badge ${SEV_CLASS[f.severity]}`}>{f.severity}</span>
        <span className="mono subtle small">{lines}</span>
        <span className="finding-title">{f.title}</span>
        <span className="subtle small">
          {f.reviewer}
          {f.verification ? ` · ${f.verification}` : ""}
          {f.redacted ? " · redacted" : ""}
          {f.truncated ? " · cut" : ""}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open && (
        <div className="finding-body">
          <p className="m-0 pre-wrap">{f.body}</p>
          {f.code && <pre className="codeblock">{f.code}</pre>}
          {f.suggestion && (
            <div>
              <div className="subtle small finding-label">Suggestion</div>
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
  );
}
