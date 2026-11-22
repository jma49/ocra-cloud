import Layers from "lucide-react/icons/layers";
import type { MouseEvent } from "react";
import { ago } from "../format.js";
import { pullPath } from "../pull/path.js";
import { navigate } from "../router.js";
import type { Row } from "./sections.js";
import { UNREAD_REASON } from "./unread.js";

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

const runClass = (run: { first: boolean; last: boolean } | null) =>
  run ? ` in-stack${run.first ? " stack-first" : ""}${run.last ? " stack-last" : ""}` : "";

/** One pull request on one line: unread mark, checks, number, title, repository, review, author, age. */
export function PullRow(props: {
  r: Row;
  i: number;
  current: boolean;
  /** Set when the rows beside it are of its stack: the rail that joins them. */
  run: { first: boolean; last: boolean } | null;
  onOpen: () => void;
  onMark: (read: boolean) => void;
}) {
  const { r } = props;
  const checks = r.checks && CHECKS[r.checks];
  const review = r.state === "open" && r.review ? REVIEW[r.review] : null;
  const when = r.mergedAt ?? r.updatedAt;
  const to = pullPath(r.platform, r.repo, r.number);
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    props.onOpen();
    navigate(to);
  };
  const why = r.unread && r.unreadReason ? UNREAD_REASON[r.unreadReason] : null;
  return (
    <div className={`pull-line${r.unread ? " unread" : ""}${runClass(props.run)}`}>
      <button
        type="button"
        className="unread-mark"
        aria-label={`Mark #${r.number} ${r.unread ? "read" : "unread"}`}
        title={r.unread ? `${why ?? "Unread"}. Mark read` : "Mark unread"}
        onClick={() => props.onMark(r.unread)}
      />
      <PullLink {...props} to={to} onClick={onClick} checks={checks} review={review} when={when} />
    </div>
  );
}

function PullLink(props: {
  r: Row;
  i: number;
  current: boolean;
  to: string;
  onClick: (e: MouseEvent) => void;
  checks: (typeof CHECKS)[keyof typeof CHECKS] | null | "";
  review: (typeof REVIEW)[keyof typeof REVIEW] | null;
  when: string;
}) {
  const { r, to, onClick, checks, review, when } = props;
  return (
    <a
      className={`pull-row${props.current ? " current" : ""}`}
      href={to}
      onClick={onClick}
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
      {r.stack && (
        <span
          className="pull-stack"
          title={`${r.stack.position} of ${r.stack.size} in its stack, from the bottom`}
        >
          <Layers size={12} aria-hidden="true" />
          {r.stack.position}/{r.stack.size}
        </span>
      )}
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
