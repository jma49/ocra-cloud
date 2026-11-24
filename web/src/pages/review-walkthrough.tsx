import { useState } from "react";
import type { ReviewWalkthroughView } from "../../../src/shared/index.js";
import { count } from "../format.js";
import { Markdown } from "../markdown.js";
import { splitPath } from "../pull/diff.js";
import { FileTypeIcon } from "../pull/file-icon.js";
import { Diagram } from "../walkthrough/diagram.js";

// The change's walkthrough above a review's findings: what it does, its files
// grouped by purpose, and the diagram's text. The model's prose is drawn as
// Markdown, which keeps links and HTML as text: it is about untrusted code.

export function Walkthrough(props: { w: ReviewWalkthroughView }) {
  const { w } = props;
  const files = new Set(w.groups.flatMap((g) => g.files)).size;
  const notes = [w.redacted && "secrets redacted", w.truncated && "shortened"].filter(Boolean);
  return (
    <details className="card walkthrough" open>
      <summary className="walkthrough-head">
        <span className="fold" aria-hidden="true" />
        <h2 className="walkthrough-title">Walkthrough</h2>
        <span className="walkthrough-meta subtle small">
          {[files > 0 && count(files, "file"), ...notes].filter(Boolean).join(" · ")}
        </span>
      </summary>
      <div className="walkthrough-body">
        <Markdown text={w.overview} />
        {w.groups.length > 0 && (
          <ul className="walkthrough-groups">
            {w.groups.map((g) => (
              <li key={g.title}>
                <h3>{g.title}</h3>
                {g.note && (
                  <div className="muted">
                    <Markdown text={g.note} />
                  </div>
                )}
                <ul className="walkthrough-files">
                  {g.files.map((f) => {
                    const { dir, name } = splitPath(f);
                    return (
                      <li key={f} title={f}>
                        <FileTypeIcon name={name} />
                        <span className="mono small">
                          <span className="subtle">{dir}</span>
                          {name}
                        </span>
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
