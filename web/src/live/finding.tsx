import type { LiveFinding } from "@open-cr-agent/cloud-contract";
import type { LiveCommentView } from "../../../src/shared/index.js";
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
        <div className="code-card">
          <div className="code-card-head">
            <span className="mono">{f.file}</span>
            <span className="mono subtle">{linesOf(f)}</span>
          </div>
        </div>
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
