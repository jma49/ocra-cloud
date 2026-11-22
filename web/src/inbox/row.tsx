import { ago } from "../format.js";
import type { Row } from "./sections.js";

const CHECKS = {
  passing: { label: "Checks pass", cls: "ok" },
  failing: { label: "Checks fail", cls: "fail" },
  pending: { label: "Checks running", cls: "wait" },
} as const;
const REVIEW = {
  approved: { label: "Approved", cls: "badge-ok" },
  changes_requested: { label: "Changes requested", cls: "badge-warn" },
  required: { label: "Review required", cls: "" },
} as const;

/** One pull request on one line: checks, number, title, repository, review, author, age. */
export function PullRow(props: { r: Row; i: number; current: boolean }) {
  const { r } = props;
  const checks = r.checks && CHECKS[r.checks];
  const review = r.state === "open" && r.review ? REVIEW[r.review] : null;
  const when = r.mergedAt ?? r.updatedAt;
  return (
    <a
      className={`pull-row${props.current ? " current" : ""}`}
      href={r.url}
      target="_blank"
      rel="noreferrer"
      data-row={props.i}
      aria-current={props.current ? "true" : undefined}
    >
      {checks ? (
        <span
          className={`chk ${checks.cls}`}
          role="img"
          aria-label={checks.label}
          title={checks.label}
        />
      ) : (
        <span className="chk" aria-hidden="true" />
      )}
      <span className="pull-num">#{r.number}</span>
      <span className="pull-title">{r.title}</span>
      <span className="pull-repo">{r.repo}</span>
      <span className="pull-review">
        {review && <span className={`badge ${review.cls}`}>{review.label}</span>}
      </span>
      {r.additions !== null && r.deletions !== null && (
        <span className="pull-diff mono">
          <span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span>
        </span>
      )}
      <span className="pull-author">{r.author ?? ""}</span>
      <time className="pull-time" dateTime={when} title={r.mergedAt ? "Merged" : "Updated"}>
        {ago(when).replace(" ago", "")}
      </time>
    </a>
  );
}
