import type { ReactNode } from "react";
import type { LearningUsageView, LearningView } from "../../../src/shared/index.js";
import { ago } from "../format.js";

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

export function LearningCard(props: {
  learning: LearningView;
  /** The reviews given this learning over the last `days`; absent where nothing counts them. */
  usage?: { of: LearningUsageView; days: number } | undefined;
  actions?: ReactNode;
}) {
  const l = props.learning;
  return (
    <details className="learning">
      <summary>
        <div className="grow">
          <div className="strong">
            {l.title} {l.critical && <span className="badge badge-err">Critical</span>}
          </div>
          <div className="subtle small">
            <span className="mono">{l.id}</span>
            {" · "}
            {l.paths.join(", ")}
            {l.source ? ` · ${SOURCE[l.source.kind]}` : ""}
            {l.lastCommit?.at ? ` · changed ${ago(l.lastCommit.at)}` : ""}
            {props.usage ? ` · ${used(props.usage.of, props.usage.days)}` : ""}
          </div>
        </div>
        {props.actions}
      </summary>
      <div className="learning-text">
        <pre className="pre-wrap">{l.body}</pre>
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
    </details>
  );
}
