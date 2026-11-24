import Layers from "lucide-react/icons/layers";
import MessageSquare from "lucide-react/icons/message-square";
import Users from "lucide-react/icons/users";
import { type MouseEvent, useEffect } from "react";
import { since } from "../format.js";
import { PersonMark } from "../person-mark.js";
import { CheckMark } from "../pull/check-mark.js";
import { pullPath } from "../pull/path.js";
import { QUEUE_STATE } from "../pull/queue-words.js";
import { navigate, prepare, useIntent } from "../router.js";
import type { Row } from "./sections.js";
import { UNREAD_REASON } from "./unread.js";

const REVIEW = {
  approved: { label: "Approved", tone: "badge badge-ok" },
  changes_requested: { label: "Changes requested", tone: "badge badge-warn" },
  required: { label: "Review required", tone: "badge" },
} as const;

type Standing = { label: string; tone: string };

/** The one thing to know before opening it: what it is, where its merge stands, then what blocks it, then how its review stands. */
function standingOf(r: Row): Standing | null {
  if (r.state !== "open") return null;
  if (r.draft) return { label: "Draft", tone: "badge" };
  if (r.queued) return QUEUE_STATE[r.queued];
  if (r.verdict === "blocking") return { label: "ocra blocks", tone: "badge badge-err" };
  if (r.review) return REVIEW[r.review];
  return r.verdict === "not_blocking" ? { label: "ocra passed", tone: "badge badge-ok" } : null;
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
  /** The signed-in user: their own pull requests do not repeat their name. */
  self?: string | undefined;
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

const REST_MS = 150;

function PullLink(props: {
  r: Row;
  i: number;
  current: boolean;
  to: string;
  onClick: (e: MouseEvent) => void;
  review: Standing | null;
  when: string;
  self?: string | undefined;
}) {
  const { r, to, onClick, review, when, current } = props;
  const intent = useIntent(to);
  // The row the keyboard rests on is the one Enter opens; one passed over on the way is not.
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => prepare(to, "hover"), REST_MS);
    return () => clearTimeout(t);
  }, [current, to]);
  return (
    <a
      {...intent}
      className={`pull-row${current ? " current" : ""}`}
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
      {r.requestedTeam && (
        <span className="pull-team" title={`Review asked of ${r.requestedTeam}, a team you are on`}>
          <Users size={12} aria-hidden="true" />
          <span className="pull-team-name">{r.requestedTeam.split("/").pop()}</span>
        </span>
      )}
      <span className="pull-ref" title={`${r.repo} #${r.number}`}>
        <RepoName repo={r.repo} /> <span className="pull-num">#{r.number}</span>
      </span>
      <span className="pull-review">
        {review && <span className={review.tone}>{review.label}</span>}
      </span>
      {r.additions !== null && r.deletions !== null && (
        <span className="pull-diff mono">
          {r.additions > 0 && <span className="add">+{r.additions}</span>}
          {r.additions > 0 && r.deletions > 0 && " "}
          {r.deletions > 0 && <span className="del">−{r.deletions}</span>}
        </span>
      )}
      <span className="pull-author">
        {r.author && r.author !== props.self && (
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

/** Names the columns once over the list; it takes the rows' own column classes, so it lines up with them at every width. */
export function ColumnHead() {
  return (
    <div className="inbox-cols" aria-hidden="true">
      <span className="pull-title">Pull request</span>
      <span className="pull-ref">Repository</span>
      <span className="pull-review">Status</span>
      <span className="pull-diff">Size</span>
      <span className="pull-author">Author</span>
      <span className="pull-time">Updated</span>
    </div>
  );
}

/** The owner gives way first when the row narrows; the repository's own name stays. */
function RepoName(props: { repo: string }) {
  const cut = props.repo.lastIndexOf("/") + 1;
  return (
    <span className="pull-repo">
      <span className="pull-owner">{props.repo.slice(0, cut)}</span>
      {props.repo.slice(cut)}
    </span>
  );
}
