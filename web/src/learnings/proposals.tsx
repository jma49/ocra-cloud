import type { LearningProposalsView, LearningProposalView } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { LearningCard } from "./learning-card.js";

// Open pull requests that propose learnings (`ocra learn --propose`, or a
// change made here): what each adds, changes and deletes, at its head.

function waitsFor(p: LearningProposalView): string {
  const merge = p.autoMerge
    ? "Merges on its own once its checks and required reviews pass"
    : "Waits for a person to merge it";
  // An answer kept from before these fields names no reviewers.
  const reviewers = p.reviewers ?? [];
  return reviewers.length ? `${merge} · review requested from ${reviewers.join(", ")}` : merge;
}

export function Proposals(props: { data: LearningProposalsView }) {
  const { proposals, more } = props.data;
  if (proposals.length === 0) return null;
  return (
    <div className="card section">
      <div className="card-head">
        <h2>
          Proposed in pull requests{" "}
          <span className="muted">
            {proposals.length}
            {more ? "+" : ""}
          </span>
        </h2>
      </div>
      {proposals.map((p) => (
        <div className="proposal" key={p.number}>
          <div className="list-row">
            <div className="grow">
              <a className="strong" href={p.url} target="_blank" rel="noreferrer">
                #{p.number} {p.title}
              </a>
              <div className="subtle small">
                {p.author ? `${p.author} · ` : ""}opened {ago(p.createdAt)} · {p.learnings.length}{" "}
                added or changed
                {p.removed.length ? `, ${p.removed.length} deleted` : ""}
              </div>
              <div className="subtle small">{waitsFor(p)}</div>
            </div>
          </div>
          {p.learnings.map((l) => (
            <LearningCard key={l.id} learning={l} />
          ))}
          {p.removed.map((id) => (
            <div className="learning removed subtle small" key={id}>
              Deletes <span className="mono">{id}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
