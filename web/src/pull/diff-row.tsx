import type { Expand } from "./context-lines.js";
import { anchorOf, type DiffLine } from "./diff.js";
import type { OpenGap } from "./diff-context.js";
import type { DiffRow } from "./diff-rows.js";
import { markRuns, type WordRange } from "./diff-words.js";
import { GapRow } from "./gap-row.js";
import type { CodeRun } from "./highlight.js";

// One row of a file's diff, unified or split. Every text is plain text: the
// diff is untrusted code.

export const lineName = (line: DiffLine) => {
  const a = anchorOf(line);
  return a?.side === "old" ? `removed line ${a.line}` : `line ${a?.line}`;
};

/** What a row needs of its lines: the line, its colours, its changed words. */
export type LineLook = {
  lines: readonly DiffLine[];
  runs: ReadonlyMap<number, CodeRun[]>;
  words: ReadonlyMap<number, WordRange[]>;
  /** Opens the comment box under a line; undefined where lines take no comment. */
  onOpen: ((line: number) => void) | undefined;
  /** The left-out lines before each hunk's head, by the head's index, and a way to show them. */
  gaps: ReadonlyMap<number, OpenGap>;
  expand: Expand | undefined;
  busy: number | null;
  /** What a find in the diffs found, by line, and the match being shown. */
  found: ReadonlyMap<number, WordRange[]>;
  current: { at: number; from: number; to: number } | null;
};

export function DiffRowView(props: { row: DiffRow; look: LineLook; columns: number }) {
  const { row, look } = props;
  if (row.kind === "hunk") {
    return (
      <GapRow
        text={look.lines[row.line]?.text ?? ""}
        gap={look.gaps.get(row.line)}
        busy={look.busy}
        expand={look.expand}
        columns={props.columns}
      />
    );
  }
  if (row.kind === "line") return <UnifiedRow at={row.line} look={look} />;
  return (
    <tr className="diff-pair">
      <Half at={row.left} side="old" look={look} />
      <Half at={row.right} side="new" look={look} />
    </tr>
  );
}

function UnifiedRow(props: { at: number; look: LineLook }) {
  const line = props.look.lines[props.at];
  if (!line || line.kind === "hunk") return null;
  const number = (n: number) => <LineNo at={props.at} n={n} look={props.look} />;
  // The button sits on the number its comment anchors to: old for a removed line, new otherwise.
  return (
    <tr className={`diff-${line.kind}`}>
      <td className="diff-no">
        {line.kind === "del" ? number(line.old) : line.kind === "context" ? line.old : ""}
      </td>
      <td className="diff-no">{line.kind === "del" ? "" : number(line.new)}</td>
      <td className="diff-code" data-at={props.at}>
        <span className="diff-sign" aria-hidden="true">
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
        </span>
        <Code at={props.at} look={props.look} />
      </td>
    </tr>
  );
}

/** One side of a split row: a context line shows on both, its comment only on the new. */
function Half(props: { at: number | null; side: "old" | "new"; look: LineLook }) {
  const line = props.at === null ? undefined : props.look.lines[props.at];
  if (props.at === null || !line || line.kind === "hunk")
    return (
      <>
        <td className="diff-no diff-empty" />
        <td className="diff-code diff-empty" />
      </>
    );
  const kind = line.kind === "context" ? "context" : line.kind;
  const n =
    props.side === "old"
      ? line.kind === "add"
        ? null
        : line.old
      : line.kind === "del"
        ? null
        : line.new;
  const commentable = props.side === "new" || line.kind === "del";
  return (
    <>
      <td className={`diff-no diff-${kind}`}>
        {n === null ? "" : commentable ? <LineNo at={props.at} n={n} look={props.look} /> : n}
      </td>
      <td className={`diff-code diff-${kind}`} data-at={props.at}>
        <Code at={props.at} look={props.look} />
      </td>
    </>
  );
}

function LineNo(props: { at: number; n: number; look: LineLook }) {
  const { onOpen } = props.look;
  const line = props.look.lines[props.at];
  if (!onOpen || !line) return <>{props.n}</>;
  return (
    <button
      type="button"
      className="diff-add-comment"
      aria-label={`Comment on ${lineName(line)}`}
      onClick={() => onOpen(props.at)}
    >
      {props.n}
    </button>
  );
}

function Code(props: { at: number; look: LineLook }) {
  const { look, at } = props;
  const line = look.lines[at];
  if (!line) return null;
  const runs = look.runs.get(at) ?? [{ text: line.text, kind: null }];
  const current = look.current?.at === at ? look.current : null;
  let offset = 0;
  return (
    <>
      {markRuns(runs, look.words.get(at), look.found.get(at)).map((run, i) => {
        const start = offset;
        offset += run.text.length;
        const cls = [
          run.kind && `tok-${run.kind}`,
          run.changed && "diff-word",
          run.found && "diff-found",
          run.found && current && start >= current.from && start < current.to && "is-current",
        ]
          .filter(Boolean)
          .join(" ");
        return cls ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's runs have no id; their order is fixed.
          <span key={i} className={cls}>
            {run.text}
          </span>
        ) : (
          run.text
        );
      })}
    </>
  );
}
