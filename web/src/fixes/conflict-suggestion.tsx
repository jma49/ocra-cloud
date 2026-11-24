import type { MendConflictView } from "../../../src/shared/index.js";
import { CodeBlock } from "../ui.js";

// A resolution ocra proposed for a pull request's merge conflicts where the
// repository does not let it merge the base branch: each region's suggested
// lines, with both sides folded under them. Every text is plain text: the
// sides are the repository's code and the suggestion is a model's.

export function ConflictSuggestion(props: { conflicts: MendConflictView[] }) {
  const files = props.conflicts.filter((c) => c.outcome === "proposed" && c.regions.length > 0);
  if (files.length === 0) return null;
  return (
    <div className="stack conflict-suggestion">
      <span className="subtle small">
        ocra's suggestion. Nothing was written to the branch: apply it yourself, or let ocra merge
        the base branch under the repository's Fixes settings.
      </span>
      {files.flatMap((file) =>
        file.regions.map((region) => (
          <div key={`${file.path}:${region.line}`} className="code-card">
            <div className="code-card-head">
              <span className="mono">{file.path}</span>
              <span className="subtle">line {region.line}</span>
            </div>
            <CodeBlock label={`Suggested lines of ${file.path} from line ${region.line}`}>
              {region.resolved}
            </CodeBlock>
            <details className="conflict-sides">
              <summary className="subtle small">
                <span className="fold" aria-hidden="true" />
                Both sides
              </summary>
              <span className="subtle small">This branch</span>
              <CodeBlock label={`This branch's lines of ${file.path}`}>{region.ours}</CodeBlock>
              <span className="subtle small">Base branch</span>
              <CodeBlock label={`The base branch's lines of ${file.path}`}>
                {region.theirs}
              </CodeBlock>
            </details>
          </div>
        )),
      )}
    </div>
  );
}
