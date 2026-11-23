import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_THREAD_REPLY_CHARS,
  type ReviewThreadView,
  type ThreadSuggestion,
} from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { splitPath } from "./diff.js";
import { FileTypeIcon } from "./file-icon.js";
import { SuggestionText } from "./suggestion.js";
import { ThreadBody } from "./thread-body.js";

const lines = (start: number | null, end: number) =>
  start === null || start === end ? `line ${end}` : `lines ${start}–${end}`;

function Suggestion(props: {
  s: ThreadSuggestion;
  picked: boolean;
  /** Why it cannot be picked now, though it could be applied. */
  blocked: string | null;
  toggle: () => void;
}) {
  const { s } = props;
  return (
    <div className="thread-suggestion">
      <SuggestionText text={s.replacement} />
      {s.applied ? (
        <span className="badge badge-ok">Applied</span>
      ) : (
        <label className="thread-apply" title={props.blocked ?? undefined}>
          <input
            type="checkbox"
            disabled={!s.applicable || props.blocked !== null}
            checked={props.picked}
            onChange={props.toggle}
          />
          <span className={s.applicable ? "" : "subtle"}>
            {s.applicable
              ? `Apply to ${lines(s.startLine, s.endLine)}`
              : "Outdated: these lines changed since"}
          </span>
        </label>
      )}
    </div>
  );
}

type ItemProps = {
  t: ReviewThreadView;
  picked: string[];
  blocked: string | null;
  toggle: (id: string) => void;
};

function Comments(props: ItemProps) {
  return props.t.comments.map((c) => (
    <div key={c.id} className="thread-comment small">
      <span className="avatar thread-avatar" aria-hidden="true">
        {(c.author ?? "?").slice(0, 1).toUpperCase()}
      </span>
      <div className="thread-said">
        <div>
          <span className="strong">{c.author ?? "Someone"}</span>
          {c.createdAt && <span className="subtle"> {ago(c.createdAt)}</span>}
        </div>
        <ThreadBody body={c.body} />
        {c.suggestions.map((s) => (
          <Suggestion
            key={s.id}
            s={s}
            picked={props.picked.includes(s.id)}
            blocked={props.picked.includes(s.id) ? null : props.blocked}
            toggle={() => props.toggle(s.id)}
          />
        ))}
      </div>
    </div>
  ));
}

/** A reply to the thread, kept while it is being written and until the platform took it. */
function Reply(props: { busy: boolean; send: (body: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  if (!open) {
    return (
      <div className="thread-foot">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Reply
        </Button>
      </div>
    );
  }
  const send = async () => {
    setSending(true);
    const took = await props.send(body.trim());
    setSending(false);
    if (!took) return;
    setBody("");
    setOpen(false);
  };
  return (
    <div className="stack-tight thread-foot">
      <textarea
        className="input"
        aria-label="Reply"
        rows={3}
        maxLength={MAX_THREAD_REPLY_CHARS}
        value={body}
        // biome-ignore lint/a11y/noAutofocus: the box opens because the person asked to reply
        autoFocus
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row-gap">
        <Button size="sm" loading={sending} disabled={props.busy || !body.trim()} onClick={send}>
          Send reply
        </Button>
        <Button variant="outline" size="sm" disabled={sending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One review thread: where it is, its comments and suggestions, a reply, and its resolve switch. */
export function ThreadItem(
  props: ItemProps & {
    resolving: boolean;
    busy: boolean;
    resolve: () => void;
    /** Sends a reply as the user; true once the platform took it. */
    reply: (body: string) => Promise<boolean>;
  },
) {
  const { t } = props;
  const { dir, name } = splitPath(t.path);
  return (
    <li className={`thread-card${t.resolved ? " is-resolved" : ""}`}>
      <div className="thread-head">
        <span className="thread-where mono small" title={t.path}>
          <FileTypeIcon name={name} />
          <span className="thread-path">
            <span className="subtle">{dir}</span>
            {name}
            {t.line !== null && <span className="subtle">:{t.line}</span>}
          </span>
        </span>
        {t.outdated && <span className="badge">Outdated</span>}
        {t.resolved && <span className="badge badge-ok">Resolved</span>}
        {t.canResolve && (
          <Button
            variant="outline"
            size="sm"
            loading={props.resolving}
            disabled={props.busy}
            onClick={props.resolve}
          >
            {t.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      {t.resolved ? (
        <details className="thread-folded">
          <summary className="subtle small">
            {t.comments.length} {t.comments.length === 1 ? "comment" : "comments"}
          </summary>
          <Comments {...props} />
        </details>
      ) : (
        <>
          <Comments {...props} />
          <Reply busy={props.busy} send={props.reply} />
        </>
      )}
    </li>
  );
}
