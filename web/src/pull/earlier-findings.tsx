import type { EarlierFindingsView, EarlierFindingView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { count } from "../format.js";
import { Link } from "../router.js";
import { SeverityBadge } from "../severity.js";
import { useLoad } from "../ui.js";

// ocra's open findings of reviews of earlier heads that no review of the head
// shown took a word on: folded under ocra's review, never left out, each
// marked outdated once the lines it is about changed since.

/** The earlier findings the API path answers; none while loading, or when they could not be read. */
export function useEarlierFindings(path: string | null): EarlierFindingView[] {
  const { data } = useLoad(
    () => (path ? api<EarlierFindingsView>(path) : Promise.resolve(null)),
    [path],
  );
  return data?.findings ?? [];
}

const where = (f: EarlierFindingView) =>
  f.lineStart === null
    ? f.file
    : `${f.file}:${f.lineStart}${f.lineEnd !== null && f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ""}`;

export function EarlierFindings(props: { findings: EarlierFindingView[] }) {
  const { findings } = props;
  if (findings.length === 0) return null;
  const outdated = findings.filter((f) => f.outdated).length;
  return (
    <details className="earlier-findings">
      <summary className="subtle small">
        <span className="fold" aria-hidden="true" />
        {`From earlier commits: ${count(findings.length, "open finding")}`}
        {outdated > 0 && `, ${outdated} outdated`}
      </summary>
      <ul className="earlier-findings-list">
        {findings.map((f) => (
          <li key={f.id}>
            <div className="row-gap">
              <SeverityBadge severity={f.severity} />
              {f.outdated && <span className="badge">Outdated</span>}
            </div>
            <Link to={`/reviews/${f.review}`}>{f.title}</Link>
            <span className="subtle small mono" title={where(f)}>
              {where(f)} · {f.head.slice(0, 7)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
