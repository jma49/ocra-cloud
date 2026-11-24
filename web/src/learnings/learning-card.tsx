import { type ReactNode, useId, useState } from "react";
import type { LearningUsageView, LearningView } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { Markdown } from "../markdown.js";

// One learning as a reviewer gets it: title, where it applies, and its text.

const SOURCE: Record<NonNullable<LearningView["source"]>["kind"], string> = {
  "fix-commit": "From a fix commit",
  "review-feedback": "From review feedback",
  document: "From a document",
  remember: "From @ocra remember",
  incident: "From an incident",
  manual: "Written by hand",
};

function used(u: LearningUsageView, days: number) {
  if (u.reviews === 0) return `not used in ${days} days`;
  const last = u.lastUsedAt ? `, last ${ago(u.lastUsedAt)}` : "";
  return `used in ${u.reviews} review${u.reviews === 1 ? "" : "s"}${last}`;
}

/** Why paths that match no file matter: what can still give the learning to a review. */
function unmatchedNote(l: LearningView, gone: readonly string[], branch: string) {
  const list = gone.map((p, i) => (
    <span key={p}>
      {i > 0 && ", "}
      <span className="mono">{p}</span>
    </span>
  ));
  const rest =
    gone.length < l.paths.length
      ? "Its other paths still apply."
      : l.keywords.length > 0 || l.symbols.length > 0
        ? "Reviews give it only by its symbols and keywords until its paths are edited."
        : "Reviews no longer give it until its paths are edited.";
  return (
    <p className="small m-0">
      No file on {branch} matches {list}. {rest}
    </p>
  );
}

export function LearningCard(props: {
  learning: LearningView;
  /** The reviews given this learning over the last `days`; absent where nothing counts them. */
  usage?: { of: LearningUsageView; days: number } | undefined;
  /** Its paths that match no file on `branch`; absent when all match or nothing was checked. */
  unmatched?: { paths: readonly string[]; branch: string } | undefined;
  actions?: ReactNode;
}) {
  const l = props.learning;
  const gone = props.unmatched?.paths ?? [];
  const [open, setOpen] = useState(false);
  const text = useId();
  return (
    <div className="learning" data-open={open || undefined}>
      <div className="learning-row">
        <button
          type="button"
          className="learning-toggle"
          aria-expanded={open}
          aria-controls={text}
          onClick={() => setOpen(!open)}
        >
          <span className="strong">
            {l.title} {l.critical && <span className="badge badge-err">Critical</span>}
            {gone.length > 0 && (
              <>
                {" "}
                <span className="badge badge-warn">
                  {gone.length < l.paths.length
                    ? "Some paths match no file"
                    : "Paths match no file"}
                </span>
              </>
            )}
          </span>
          <span className="subtle small">
            <span className="mono">{l.id}</span>
            {" · "}
            {l.paths.join(", ")}
            {l.source ? ` · ${SOURCE[l.source.kind]}` : ""}
            {l.lastCommit?.at ? ` · changed ${ago(l.lastCommit.at)}` : ""}
            {props.usage ? ` · ${used(props.usage.of, props.usage.days)}` : ""}
          </span>
        </button>
        {props.actions}
      </div>
      <div className="learning-text" id={text} hidden={!open}>
        {props.unmatched && gone.length > 0 && unmatchedNote(l, gone, props.unmatched.branch)}
        <Markdown text={l.body} />
        {(l.symbols.length > 0 || l.keywords.length > 0) && (
          <p className="subtle small m-0">
            {l.symbols.length > 0 && (
              <>
                Symbols <span className="mono">{l.symbols.join(", ")}</span>
              </>
            )}
            {l.symbols.length > 0 && l.keywords.length > 0 && " · "}
            {l.keywords.length > 0 && <>Keywords {l.keywords.join(", ")}</>}
          </p>
        )}
      </div>
    </div>
  );
}
