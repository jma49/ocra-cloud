import { ago } from "../format.js";
import type { Row } from "./sections.js";

const CHECKS = {
  passing: { label: "Checks pass", cls: "badge-ok" },
  failing: { label: "Checks fail", cls: "badge-warn" },
  pending: { label: "Checks running", cls: "" },
} as const;
const REVIEW = {
  approved: { label: "Approved", cls: "badge-ok" },
  changes_requested: { label: "Changes requested", cls: "badge-warn" },
  required: { label: "Review required", cls: "" },
} as const;

export function PullRow(props: { r: Row; i: number; current: boolean }) {
  const { r } = props;
  const checks = r.checks && CHECKS[r.checks];
  const review = r.state === "open" && r.review ? REVIEW[r.review] : null;
  const when = r.mergedAt ? `merged ${ago(r.mergedAt)}` : `updated ${ago(r.updatedAt)}`;
  return (
    <a
      className={`list-row pull-row${props.current ? " current" : ""}`}
      href={r.url}
      target="_blank"
      rel="noreferrer"
      data-row={props.i}
      aria-current={props.current ? "true" : undefined}
    >
      <div className="grow">
        <div className="pull-title">{r.title}</div>
        <div className="mono subtle small">
          {r.repo}#{r.number}
          {r.author ? ` · ${r.author}` : ""} · {when}
        </div>
      </div>
      {checks && <span className={`badge ${checks.cls}`}>{checks.label}</span>}
      {review && <span className={`badge ${review.cls}`}>{review.label}</span>}
      {r.additions !== null && r.deletions !== null && (
        <span className="mono small subtle">
          +{r.additions} −{r.deletions}
        </span>
      )}
    </a>
  );
}
