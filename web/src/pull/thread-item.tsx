import { Button } from "@/components/ui/button";
import type { ReviewThreadView, ThreadSuggestion } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { splitPath } from "./diff.js";
import { SuggestionText } from "./suggestion.js";

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
      <div>
        <span className="strong">{c.author ?? "Someone"}</span>
        {c.createdAt && <span className="subtle"> {ago(c.createdAt)}</span>}
      </div>
      {c.body && <div className="pre-wrap">{c.body}</div>}
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
  ));
}

/** One review thread: where it is, its comments and suggestions, and its resolve switch. */
export function ThreadItem(
  props: ItemProps & { resolving: boolean; busy: boolean; resolve: () => void },
) {
  const { t } = props;
  const { dir, name } = splitPath(t.path);
  return (
    <li className={t.resolved ? "is-resolved" : undefined}>
      <div className="thread-head">
        <span className="thread-where mono small" title={t.path}>
          <span className="thread-path">
            <span className="subtle">{dir}</span>
            {name}
          </span>
          {t.line !== null && <span className="subtle">:{t.line}</span>}
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
        <Comments {...props} />
      )}
    </li>
  );
}
