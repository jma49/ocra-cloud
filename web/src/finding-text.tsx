import { Markdown } from "./markdown.js";

/** What a finding says and the fix it suggests, as the reviewer wrote them. */
export function FindingText(props: { body: string; suggestion: string | null }) {
  return (
    <div className="finding-text">
      <Markdown text={props.body} />
      {props.suggestion && (
        <div>
          <div className="quiet-label finding-label">Suggested fix</div>
          <Markdown text={props.suggestion} />
        </div>
      )}
    </div>
  );
}
