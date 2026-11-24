import CircleDot from "lucide-react/icons/circle-dot";
import Clock from "lucide-react/icons/clock";
import Diff from "lucide-react/icons/diff";
import FolderGit2 from "lucide-react/icons/folder-git-2";
import GitPullRequest from "lucide-react/icons/git-pull-request";
import Layers from "lucide-react/icons/layers";
import MessageSquare from "lucide-react/icons/message-square";
import MessagesSquare from "lucide-react/icons/messages-square";
import User from "lucide-react/icons/user";
import Users from "lucide-react/icons/users";
import { type MouseEvent, useEffect } from "react";
import { Status, type StatusTone } from "@/components/status";
import { EyesMark } from "../eyes.js";
import { since } from "../format.js";
import { PersonMark } from "../person-mark.js";
import { PlatformMark } from "../platform-mark.js";
import { CheckMark } from "../pull/check-mark.js";
import { pullPath } from "../pull/path.js";
import { QUEUE_STATE } from "../pull/queue-words.js";
import { navigate, prepare, useIntent } from "../router.js";
import type { Row } from "./sections.js";
import { UNREAD_REASON } from "./unread.js";

const REVIEW = {
  approved: { label: "Approved", tone: "ok" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  required: { label: "Review required", tone: "quiet" },
} as const;

type Standing = { label: string; tone: StatusTone };

const QUEUE_TONE: Record<keyof typeof QUEUE_STATE, StatusTone> = {
  waiting: "quiet",
  checking: "run",
  ready: "ok",
  merging: "run",
  blocked: "err",
};

/** The one thing to know before opening it: what it is, where its merge stands, then what blocks it, then how its review stands. */
function standingOf(r: Row): Standing | null {
  if (r.state !== "open") return null;
  if (r.draft) return { label: "Draft", tone: "quiet" };
  if (r.queued) return { label: QUEUE_STATE[r.queued].label, tone: QUEUE_TONE[r.queued] };
  if (r.verdict === "blocking") return { label: "ocra blocks", tone: "err" };
  if (r.review) return REVIEW[r.review];
  return r.verdict === "not_blocking" ? { label: "ocra passed", tone: "ok" } : null;
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

const REST_MS = 150;

function PullLink(props: {
  r: Row;
  i: number;
  current: boolean;
  to: string;
  onClick: (e: MouseEvent) => void;
  review: Standing | null;
  when: string;
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
      <PullTalk r={r} />
      <span className="pull-ref" title={`${r.repo} #${r.number}`}>
        <PlatformMark platform={r.platform} size={14} />
        <span className="pull-ref-text">
          <RepoName repo={r.repo} /> <span className="pull-num">#{r.number}</span>
        </span>
      </span>
      <span className="pull-review">
        {review && <Status tone={review.tone}>{review.label}</Status>}
      </span>
      {r.additions !== null && r.deletions !== null && (
        <span className="pull-diff">
          {r.additions > 0 && <span className="add">+{r.additions}</span>}
          {r.additions > 0 && r.deletions > 0 && " "}
          {r.deletions > 0 && <span className="del">−{r.deletions}</span>}
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

const OCRA_SAID = { blocking: "ocra reviewed it and blocks it", not_blocking: "ocra reviewed it" };

/** Who has talked on it: ocra's mark once ocra reviewed it, then its review threads, resolved of all. */
function PullTalk(props: { r: Row }) {
  const { verdict, threads } = props.r;
  return (
    <span className="pull-talk">
      {verdict && (
        <span className="ocra-mark" title={OCRA_SAID[verdict]}>
          <EyesMark size={12} />
        </span>
      )}
      {threads && (
        <span
          className="pull-threads"
          title={`${threads.resolved} of ${threads.total} review ${threads.total === 1 ? "thread" : "threads"} resolved`}
        >
          <MessagesSquare size={14} aria-hidden="true" />
          {threads.resolved}/{threads.total}
        </span>
      )}
    </span>
  );
}

/** Names the columns once over the list; it takes the rows' own column classes, so it lines up with them at every width. */
export function ColumnHead() {
  return (
    <div className="inbox-cols" aria-hidden="true">
      <span className="chk">
        <GitPullRequest size={14} />
      </span>
      <span className="pull-title">Pull request</span>
      <span className="pull-talk">
        <MessagesSquare size={14} />
        Threads
      </span>
      <span className="pull-ref">
        <FolderGit2 size={14} />
        Repository
      </span>
      <span className="pull-review">
        <CircleDot size={14} />
        Status
      </span>
      <span className="pull-diff">
        <Diff size={14} />
        Size
      </span>
      <span className="pull-author">
        <span className="col-mark">
          <User size={14} />
        </span>
        Author
      </span>
      <span className="pull-time">
        <Clock size={14} />
        Updated
      </span>
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
