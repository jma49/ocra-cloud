import type {
  PullReadinessView,
  ReadinessKind,
  ReadinessState,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { CloseGlyph, DoneGlyph } from "../glyphs.js";
import { useLoad } from "../ui.js";

// What still stands between this pull request and its merge, one line per
// requirement, read live as the user.

const LABEL: Record<ReadinessKind, string> = {
  draft: "Draft",
  conflicts: "Conflicts",
  approvals: "Approvals",
  code_owners: "Code owners",
  required_checks: "Required checks",
  threads: "Threads",
  premerge_checks: "Pre-merge checks",
};

const SUMMARY: Record<ReadinessState, { text: string; tone: string }> = {
  met: { text: "Ready to merge", tone: "badge badge-ok" },
  unmet: { text: "Not ready", tone: "badge badge-err" },
  pending: { text: "Waiting", tone: "badge" },
  unknown: { text: "Partly unknown", tone: "badge badge-warn" },
};

function Mark(props: { state: ReadinessState }) {
  if (props.state === "met")
    return (
      <span className="check-mark ok" role="img" aria-label="Met">
        <DoneGlyph size={14} />
      </span>
    );
  if (props.state === "unmet")
    return (
      <span className="check-mark err" role="img" aria-label="Not met">
        <CloseGlyph size={14} />
      </span>
    );
  return (
    <span
      className="check-mark muted"
      role="img"
      aria-label={props.state === "pending" ? "Pending" : "Unknown"}
    />
  );
}

type Pull = { platform: string; repo: string; number: number };

export function ReadinessBox(props: { pull: Pull; head: string }) {
  const q = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data } = useLoad(
    () => api<PullReadinessView>(`/pulls/readiness?${q}`),
    [q.toString(), props.head],
  );
  if (!data?.ready) return null;
  const s = SUMMARY[data.ready];
  return (
    <section className="card card-pad stack" aria-label="Merge readiness">
      <div className="row-gap checks-head">
        <span className="strong grow">Merge readiness</span>
        <span className={s.tone}>{s.text}</span>
      </div>
      <ul className="check-results">
        {data.items.map((i) => (
          <li key={i.kind}>
            <Mark state={i.state} />
            <div>
              <div>{LABEL[i.kind]}</div>
              <div className="subtle small">{i.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
