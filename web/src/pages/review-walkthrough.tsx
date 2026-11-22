import { useState } from "react";
import type { ReviewWalkthroughView } from "../../../src/shared/index.js";
import { splitPath } from "../pull/diff.js";
import { Diagram } from "../walkthrough/diagram.js";

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
        {w.diagram && <DiagramFold source={w.diagram} />}
      </div>
    </details>
  );
}

// The drawing loads Mermaid, so it starts only once the fold is opened.
function DiagramFold(props: { source: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="walkthrough-diagram" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="small muted">Diagram</summary>
      {open && <Diagram source={props.source} />}
      <details className="walkthrough-source">
        <summary className="small subtle">Mermaid text</summary>
        <pre className="mono small">{props.source}</pre>
      </details>
    </details>
  );
}
