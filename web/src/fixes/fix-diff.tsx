import type { FixProposalView } from "../../../src/shared/index.js";

// A fix as a diff of the lines it replaces: removed lines at their numbers at
// the reviewed head, then what the fix writes. Every text is plain text: the
// lines are untrusted code and the fix is a model's.

type Fix = Pick<FixProposalView, "startLine" | "endLine" | "before" | "after">;

export function FixDiff(props: { fix: Fix }) {
  const { startLine, endLine, before, after } = props.fix;
  return (
    <div className="diff-scroll fix-diff">
      <table className="diff">
        <tbody>
          {before === null ? (
            <tr className="diff-hunk">
              <td colSpan={3}>
                Replaces line{endLine === startLine ? ` ${startLine}` : `s ${startLine}–${endLine}`}
              </td>
            </tr>
          ) : (
            before.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fix's lines have no id; their order is fixed.
              <tr key={`d${i}`} className="diff-del">
                <td className="diff-no">{startLine + i}</td>
                <td className="diff-no" />
                <Code sign="−" text={text} />
              </tr>
            ))
          )}
          {after.length === 0 ? (
            <tr className="diff-hunk">
              <td colSpan={3}>Deletes these lines</td>
            </tr>
          ) : (
            after.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fix's lines have no id; their order is fixed.
              <tr key={`a${i}`} className="diff-add">
                <td className="diff-no" />
                <td className="diff-no">{startLine + i}</td>
                <Code sign="+" text={text} />
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Code(props: { sign: string; text: string }) {
  return (
    <td className="diff-code">
      <span className="diff-sign" aria-hidden="true">
        {props.sign}
      </span>
      {props.text}
    </td>
  );
}
