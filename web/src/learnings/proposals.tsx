import type { LearningProposalsView } from "../../../src/shared/index.js";
import { ago } from "../format.js";
import { LearningCard } from "./learning-card.js";

// Open pull requests that propose learnings (`ocra learn --propose`, or a
// change made here): what each adds, changes and deletes, at its head.

export function Proposals(props: { data: LearningProposalsView }) {
  const { proposals, more } = props.data;
  if (proposals.length === 0) return null;
  return (
    <div className="card section">
      <div className="card-head">
        <h3>
          Proposed in pull requests{" "}
          <span className="muted">
            {proposals.length}
            {more ? "+" : ""}
          </span>
        </h3>
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
