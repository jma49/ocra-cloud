import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type { LiveCommentView } from "../../../src/shared/index.js";
import { MAX_LIVE_COMMENT } from "../../../src/shared/index.js";
import { why } from "../api.js";
import { ago } from "../format.js";

// Comments on a live run: a thread under a finding, or the run's own.
// Their text is shown as text.

export type CommentActions = {
  add: (body: string, findingId: string | null) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
};

export function CommentThread(props: {
  comments: readonly LiveCommentView[];
  findingId: string | null;
  canComment: boolean;
  actions: CommentActions;
  placeholder: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const remove = async (id: string) => {
    setError(null);
    try {
      await props.actions.remove(id);
    } catch (e) {
      setError(why(e));
    }
  };
  return (
    <div className="live-thread">
      {props.comments.length > 0 && (
        <ul className="live-comments">
          {props.comments.map((c) => (
            <li key={c.id} className="live-comment">
              <div className="live-comment-meta">
                <span className="strong">{c.author}</span>
                <span className="subtle">{ago(c.createdAt)}</span>
                {c.removable && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(c.id)}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="live-comment-body">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error small m-0" role="alert">
          {error}
        </p>
      )}
      {props.canComment && (
        <CommentForm
          placeholder={props.placeholder}
          onSend={(body) => props.actions.add(body, props.findingId)}
        />
      )}
    </div>
  );
}

function CommentForm(props: { placeholder: string; onSend: (body: string) => Promise<unknown> }) {
  const [body, setBody] = useState("");
  const [state, setState] = useState<"" | "sending" | string>("");
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setState("sending");
    try {
      await props.onSend(text);
      setBody("");
      setState("");
    } catch (err) {
      setState(why(err));
    }
  };
  return (
    <form className="live-comment-form" onSubmit={send}>
      <textarea
        className="input"
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        rows={2}
        maxLength={MAX_LIVE_COMMENT}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="live-comment-foot">
        {state && state !== "sending" && (
          <span className="error small" role="alert">
            {state}
          </span>
        )}
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={state === "sending" || !body.trim()}
        >
          Comment
        </Button>
      </div>
    </form>
  );
}
