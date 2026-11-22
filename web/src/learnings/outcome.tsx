import type { LearningChangeView } from "../../../src/shared/index.js";

// What a change to a learning came to, in words.

export function ChangeOutcome(props: { change: LearningChangeView; branch: string }) {
  const { change } = props;
  if (change.outcome === "conflict")
    return (
      <p className="error" role="status">
        <span className="mono">{change.path}</span> changed since this page read it. Reload and make
        the change again.
      </p>
    );
  if (change.outcome === "refused")
    return (
      <p className="error" role="status">
        The platform refused the change to <span className="mono">{change.path}</span>: you may not
        have write access, or the branch is protected.
      </p>
    );
  return (
    <p className="note ok" role="status">
      {change.pull ? (
        <span>
          Opened{" "}
          <a href={change.pull.url} target="_blank" rel="noreferrer">
            pull request #{change.pull.number}
          </a>{" "}
          for <span className="mono">{change.path}</span>. Reviews use it once it merges.
        </span>
      ) : (
        <span>
          Committed <span className="mono">{change.path}</span> to {props.branch}.
        </span>
      )}
    </p>
  );
}
