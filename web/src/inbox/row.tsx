import Layers from "lucide-react/icons/layers";
import MessageSquare from "lucide-react/icons/message-square";
import type { MouseEvent } from "react";
import { since } from "../format.js";
import { PersonMark } from "../person-mark.js";
import { CheckMark } from "../pull/check-mark.js";
import { pullPath } from "../pull/path.js";
import { navigate } from "../router.js";
import type { Row } from "./sections.js";
import { UNREAD_REASON } from "./unread.js";

const REVIEW = {
  approved: { label: "Approved", cls: "badge-ok" },
  changes_requested: { label: "Changes requested", cls: "badge-warn" },
  required: { label: "Review required", cls: "" },
} as const;

type Standing = { label: string; cls: string };

/** The one thing to know before opening it: what it is, then what blocks it, then how its review stands. */
function standingOf(r: Row): Standing | null {
  if (r.state !== "open") return null;
  if (r.draft) return { label: "Draft", cls: "" };
  if (r.verdict === "blocking") return { label: "ocra blocks", cls: "badge-err" };
  if (r.review) return REVIEW[r.review];
  return r.verdict === "not_blocking" ? { label: "ocra passed", cls: "badge-ok" } : null;
}

const runClass = (run: { first: boolean; last: boolean } | null) =>
  run ? ` in-stack${run.first ? " stack-first" : ""}${run.last ? " stack-last" : ""}` : "";

/** One pull request on one line: unread mark, checks, title, where it lives, standing, size, author, age. */
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
  const review = standingOf(r);
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
      <PullLink {...props} to={to} onClick={onClick} review={review} when={when} />
    </div>
  );
}

function PullLink(props: {
  r: Row;
  i: number;
  current: boolean;
  to: string;
  onClick: (e: MouseEvent) => void;
  review: Standing | null;
  when: string;
}) {
  const { r, to, onClick, review, when } = props;
  return (
    <a
      className={`pull-row${props.current ? " current" : ""}`}
      href={to}
      onClick={onClick}
      data-row={props.i}
      aria-current={props.current ? "true" : undefined}
    >
      <CheckMark checks={r.checks} />
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
      {r.repliesWaiting > 0 && (
        <span
          className="pull-replies"
          title={`${r.repliesWaiting} ${r.repliesWaiting === 1 ? "reply" : "replies"} waiting for you`}
        >
          <MessageSquare size={12} aria-hidden="true" />
          {r.repliesWaiting}
        </span>
      )}
      <span className="pull-ref" title={`${r.repo} #${r.number}`}>
        <span className="pull-repo">{r.repo}</span> <span className="pull-num">#{r.number}</span>
      </span>
      <span className="pull-review">
        {review && <span className={`badge ${review.cls}`}>{review.label}</span>}
      </span>
      {r.additions !== null && r.deletions !== null && (
        <span className="pull-diff mono">
          <span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span>
        </span>
      )}
      <span className="pull-author">
        {r.author && (
          <>
            <PersonMark login={r.author} avatar={r.authorAvatar} size={18} />
            <span className="pull-author-login">{r.author}</span>
          </>
        )}
      </span>
      <time className="pull-time" dateTime={when} title={r.mergedAt ? "Merged" : "Updated"}>
        {since(when)}
      </time>
    </a>
  );
}
