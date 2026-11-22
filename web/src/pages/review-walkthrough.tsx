import type { ReviewWalkthroughView } from "../../../src/shared/index.js";
import { splitPath } from "../pull/diff.js";

// The change's walkthrough above a review's findings: what it does, its files
// grouped by purpose, and the diagram's text. All of it is plain text: the
// walkthrough is model output about untrusted code.

export function Walkthrough(props: { w: ReviewWalkthroughView }) {
  const { w } = props;
  return (
    <details className="card walkthrough" open>
      <summary className="walkthrough-head">
        <span className="fold" aria-hidden="true" />
        <span className="strong">Walkthrough</span>
        {(w.redacted || w.truncated) && (
          <span className="subtle small">
            {[w.redacted && "secrets redacted", w.truncated && "shortened"]
              .filter(Boolean)
              .join(", ")}
          </span>
        )}
      </summary>
      <div className="card-pad stack">
        <p className="pre-wrap m-0">{w.overview}</p>
        {w.groups.length > 0 && (
          <ul className="walkthrough-groups">
            {w.groups.map((g) => (
              <li key={g.title}>
                <div className="strong">{g.title}</div>
                {g.note && <p className="muted m-0">{g.note}</p>}
                <ul className="walkthrough-files">
                  {g.files.map((f) => {
                    const { dir, name } = splitPath(f);
                    return (
                      <li key={f} className="mono small" title={f}>
                        <span className="subtle">{dir}</span>
                        {name}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {w.diagram && (
          <details className="walkthrough-diagram">
            <summary className="small muted">Diagram (Mermaid)</summary>
            <pre className="mono small">{w.diagram}</pre>
          </details>
        )}
      </div>
    </details>
  );
}
