import type { LiveFinding } from "@open-cr-agent/cloud-contract";
import type { LiveCommentView } from "../../../src/shared/index.js";
import { splitPath } from "../pull/diff.js";
import { FileTypeIcon } from "../pull/file-icon.js";
import { SeverityBadge } from "../severity.js";
import { CodeBlock } from "../ui.js";
import { type CommentActions, CommentThread } from "./comments.js";

// A finding as it arrives in a live run, with its comments. Plain text
// throughout: findings quote untrusted code.

const linesOf = (f: LiveFinding) =>
  f.lineStart === undefined
    ? ""
    : f.lineEnd && f.lineEnd !== f.lineStart
      ? `L${f.lineStart}–${f.lineEnd}`
      : `L${f.lineStart}`;

/** Where a finding is: the file's icon, its path with the name in front, its lines. */
function FileChip(props: { path: string; lines: string }) {
  const { dir, name } = splitPath(props.path);
  return (
    <span className="file-chip mono" title={props.path}>
      <FileTypeIcon name={name} />
      <span className="file-chip-path">
        <span className="subtle">{dir}</span>
        {name}
      </span>
      {props.lines && <span className="subtle">{props.lines}</span>}
    </span>
  );
}

export function LiveFindingEvent(props: {
  f: LiveFinding;
  comments: readonly LiveCommentView[];
  canComment: boolean;
  actions: CommentActions;
}) {
  const { f } = props;
  return (
    <li className="event finding" id={`finding-${f.id}`}>
      <span className={`event-mark sev-${f.severity}`} aria-hidden="true" />
      <div className="event-body">
        <div className="event-meta">
          <SeverityBadge severity={f.severity} />
          <span className="subtle">
            {f.reviewer}
            {f.verification ? ` · ${f.verification}` : ""}
            {f.preExisting ? " · pre-existing" : ""}
          </span>
        </div>
        <p className="event-text finding-title">{f.title}</p>
        <FileChip path={f.file} lines={linesOf(f)} />
        <p className="event-text live-finding-body">{f.body}</p>
        {f.suggestion && <CodeBlock label="Suggested change">{f.suggestion}</CodeBlock>}
        <CommentThread
          comments={props.comments}
          findingId={f.id}
          canComment={props.canComment}
          actions={props.actions}
          placeholder="Comment on this finding"
        />
      </div>
    </li>
  );
}
