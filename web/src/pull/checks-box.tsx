import type {
  MergeCheckResultView,
  MergeChecksConclusion,
  PullChecksView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { ago } from "../format.js";
import { CloseGlyph, DoneGlyph } from "../glyphs.js";
import { KIND_LABEL } from "../merge-checks/describe.js";
import { useLoad } from "../ui.js";
import { Tally } from "./tally.js";

// The repository's pre-merge checks on this head, evaluated live: what
// passed, what blocks the merge, what only warns.

const CONCLUSION: Record<MergeChecksConclusion, { text: string; tone: string }> = {
  success: { text: "All checks pass", tone: "badge badge-ok" },
  neutral: { text: "Warnings", tone: "badge badge-warn" },
  failure: { text: "Blocked", tone: "badge badge-err" },
  pending: { text: "Waiting for the review", tone: "badge" },
};

type Pull = { platform: string; repo: string; number: number };

function Mark(props: { r: MergeCheckResultView }) {
  if (props.r.outcome === "passed")
    return (
      <span className="check-mark ok" role="img" aria-label="Passed">
        <DoneGlyph size={14} />
      </span>
    );
  if (props.r.outcome === "failed")
    return (
      <span
        className={`check-mark ${props.r.mode === "block" ? "err" : "warn"}`}
        role="img"
        aria-label={props.r.mode === "block" ? "Failed, blocks" : "Failed, warns"}
      >
        <CloseGlyph size={14} />
      </span>
    );
  return <span className="check-mark muted" role="img" aria-label="Not evaluated" />;
}

export function ChecksBox(props: { pull: Pull; head: string }) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data } = useLoad(
    () => api<PullChecksView>(`/pulls/checks?${q}`),
    [q.toString(), props.head],
  );
  const report = data?.report;
  if (!report) return null;
  const c = CONCLUSION[report.conclusion];
  const n = (pick: (r: MergeCheckResultView) => boolean) => report.results.filter(pick).length;
  const passed = n((r) => r.outcome === "passed");
  return (
    <section className="card card-pad stack" aria-label="Pre-merge checks">
      <div className="row-gap checks-head">
        <span className="strong grow">Pre-merge checks</span>
        <span className={c.tone}>{c.text}</span>
      </div>
      <Tally
        label={`${passed} of ${report.results.length} passed`}
        parts={[
          { tone: "ok", n: passed },
          { tone: "err", n: n((r) => r.outcome === "failed" && r.mode === "block") },
          { tone: "warn", n: n((r) => r.outcome === "failed" && r.mode !== "block") },
          { tone: "wait", n: n((r) => r.outcome !== "passed" && r.outcome !== "failed") },
        ]}
      />
      <ul className="check-results">
        {report.results.map((r) => (
          <li key={r.id}>
            <Mark r={r} />
            <div>
              <div>
                {KIND_LABEL[r.kind]}
                {r.mode === "warn" && <span className="subtle"> · warns</span>}
              </div>
              <div className="subtle small">{r.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {data?.postedAt && (
        <span className="subtle small">Posted on the platform {ago(data.postedAt)}.</span>
      )}
    </section>
  );
}
