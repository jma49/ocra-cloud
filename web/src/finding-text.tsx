import { Markdown } from "./markdown.js";

/** What a finding says, the fix it suggests and the facts behind it, as the reviewer wrote them. */
export function FindingText(props: {
  body: string;
  suggestion: string | null;
  evidence?: readonly string[] | null;
}) {
  return (
    <div className="finding-text">
      <Markdown text={props.body} />
      {props.suggestion && (
        <div>
          <div className="quiet-label finding-label">Suggested fix</div>
          <Markdown text={props.suggestion} />
        </div>
      )}
      {props.evidence && props.evidence.length > 0 && (
        <Evidence text={props.evidence.map((fact) => `- ${fact}`).join("\n")} />
      )}
    </div>
  );
}

/** The facts behind a finding, folded as its comment on the platform folds them. */
export function Evidence(props: { text: string }) {
  return (
    <details className="evidence">
      <summary className="subtle">
        <span className="fold" aria-hidden="true" />
        Evidence
      </summary>
      <Markdown text={props.text} />
    </details>
  );
}
