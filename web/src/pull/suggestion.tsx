/** A suggested change's new text, as code. */
export function SuggestionText(props: { text: string }) {
  return (
    <pre className="suggestion-text">
      {props.text === "" ? <span className="subtle">Delete these lines</span> : props.text}
    </pre>
  );
}
