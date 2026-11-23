import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  FixProposalView,
  LineComment,
  PullActionOutcome,
  PullFilesView,
  PullFindingView,
} from "../../../src/shared/index.js";
import { FixProposal } from "../fixes/fix-proposal.js";
import { anchorOf, type DiffLine, parsePatch, placeOnLines, splitPath } from "./diff.js";
import { FileTypeIcon } from "./file-icon.js";
import { FindingNote, underLine } from "./findings.js";
import { type CodeRun, highlightDiff } from "./highlight.js";
import { SuggestionText } from "./suggestion.js";

// One changed file of a pull request: its header and its diff, where a
// line's number opens a comment box, and ocra's findings and fixes under the
// lines they are about. Comments wait in the page's review until it is sent. Every text
// is plain text: the diff is untrusted code.

type File = PullFilesView["files"][number];

const STATUS: Record<File["status"], string> = {
  added: "Added",
  removed: "Removed",
  modified: "",
  renamed: "Renamed",
};

const sameAnchor = (c: LineComment, path: string, line: DiffLine) => {
  const a = anchorOf(line);
  return a !== null && c.path === path && c.line === a.line && c.side === a.side;
};

const lineName = (line: DiffLine) => {
  const a = anchorOf(line);
  return a?.side === "old" ? `removed line ${a.line}` : `line ${a?.line}`;
};

export function FileDiff(props: {
  file: File;
  viewed: boolean;
  /** Ticks or unticks the file; a tick folds it. */
  onViewed: (viewed: boolean) => void;
  pending: LineComment[];
  onComment: (c: LineComment) => void;
  onDrop: (c: LineComment) => void;
  /** ocra's open findings in this file, and the review they are of. */
  findings: readonly PullFindingView[];
  review: string | null;
  fixes: readonly FixProposalView[];
  onFixDone: (outcome: PullActionOutcome) => void;
  /** Shows the diff without a way to comment on its lines. */
  readOnly?: boolean;
}) {
  const { file } = props;
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const fixesAt = useMemo(() => placeOnLines(lines, props.fixes), [lines, props.fixes]);
  const findingsAt = useMemo(
    () => placeOnLines(lines, props.findings.map(underLine)),
    [lines, props.findings],
  );
  const { review } = props;
  // What is wrong, then what would fix it.
  const fixRows = (i: number) => (
    <>
      {review &&
        findingsAt.get(i)?.map((f) => (
          <tr key={f.id} className="diff-note">
            <td colSpan={3}>
              <FindingNote finding={f} review={review} />
            </td>
          </tr>
        ))}
      {fixesAt.get(i)?.map((fix) => (
        <tr key={fix.finding} className="diff-note">
          <td colSpan={3}>
            <FixProposal fix={fix} onDone={props.onFixDone} />
          </td>
        </tr>
      ))}
    </>
  );
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // A suggestion replaces the commented new line; null while the comment carries none.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [folded, setFolded] = useState(file.status === "removed" || props.viewed);
  // A tick, from the box or the page's key, folds the file.
  useEffect(() => {
    if (props.viewed) setFolded(true);
  }, [props.viewed]);
  const { dir, name } = splitPath(file.path);
  const [runs, setRuns] = useState<Map<number, CodeRun[]>>(NO_RUNS);
  useEffect(() => {
    if (folded) return;
    let live = true;
    // A diff the highlighter cannot read is drawn plain, as it was before.
    highlightDiff(file.path, lines).then(
      (r) => live && setRuns(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [folded, file.path, lines]);
  const add = (line: DiffLine) => {
    const a = anchorOf(line);
    if (!a || (!draft.trim() && suggestion === null)) return;
    props.onComment({
      path: file.path,
      ...a,
      body: draft.trim(),
      ...(suggestion !== null && a.side === "new" ? { suggestion } : {}),
    });
    setDraft("");
    setSuggestion(null);
    setOpen(null);
  };
  return (
    <section
      className={`card diff-file${props.viewed ? " is-viewed" : ""}`}
      id={`file-${file.path}`}
      data-path={file.path}
      aria-label={file.path}
    >
      <div className="diff-head-row">
        <button
          type="button"
          className="diff-head"
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
        >
          <span className="fold" aria-hidden="true" />
          <FileTypeIcon name={name} />
          <span className="mono diff-path" title={file.path}>
            {file.status === "renamed" && <span className="subtle">{file.oldPath} → </span>}
            <span className="subtle">{dir}</span>
            <span className="diff-name">{name}</span>
          </span>
          {STATUS[file.status] && <span className="badge">{STATUS[file.status]}</span>}
          <span className="diff-count">
            <span className="add-n">+{file.additions}</span>{" "}
            <span className="del-n">−{file.deletions}</span>
          </span>
        </button>
        <label className="check small diff-viewed">
          <input
            type="checkbox"
            aria-label={`Viewed ${file.path}`}
            checked={props.viewed}
            onChange={(e) => props.onViewed(e.target.checked)}
          />
          Viewed
        </label>
      </div>
      {!folded &&
        (file.patch === null ? (
          <p className="card-pad subtle small m-0">
            The platform sent no diff for this file (binary or too large).
          </p>
        ) : (
          <div className="diff-scroll">
            <table className="diff">
              <tbody>
                {fixRows(-1)}
                {lines.map((line, i) => {
                  const here = props.pending.filter((c) => sameAnchor(c, file.path, line));
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no id; their order is fixed.
                    <Fragment key={i}>
                      <Row
                        line={line}
                        runs={runs.get(i)}
                        onOpen={
                          props.readOnly
                            ? undefined
                            : () => {
                                setOpen(open === i ? null : i);
                                setSuggestion(null);
                              }
                        }
                      />
                      {fixRows(i)}
                      {here.map((c) => (
                        <tr key={props.pending.indexOf(c)} className="diff-note">
                          <td colSpan={3}>
                            <div className="diff-comment">
                              <div className="stack grow">
                                {c.body && <span className="pre-wrap">{c.body}</span>}
                                {c.suggestion !== undefined && (
                                  <SuggestionText text={c.suggestion} />
                                )}
                              </div>
                              <Button variant="outline" size="sm" onClick={() => props.onDrop(c)}>
                                Remove
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {open === i && (
                        <tr className="diff-note">
                          <td colSpan={3}>
                            <div className="diff-comment-box">
                              <textarea
                                className="input"
                                aria-label={`Your comment on ${lineName(line)}`}
                                placeholder="Leave a comment"
                                rows={3}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                              />
                              {line.kind !== "del" &&
                                (suggestion === null ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSuggestion(line.text)}
                                  >
                                    Suggest a change
                                  </Button>
                                ) : (
                                  <div className="stack-tight">
                                    <div className="row-gap suggest-head">
                                      <span className="subtle small grow">
                                        Replaces {lineName(line)} when committed
                                      </span>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setSuggestion(null)}
                                      >
                                        Remove suggestion
                                      </Button>
                                    </div>
                                    <textarea
                                      className="input mono suggest-input"
                                      aria-label={`Suggested text for ${lineName(line)}`}
                                      rows={Math.max(2, suggestion.split("\n").length)}
                                      spellCheck={false}
                                      value={suggestion}
                                      onChange={(e) => setSuggestion(e.target.value)}
                                    />
                                  </div>
                                ))}
                              <div className="row-gap">
                                <Button
                                  size="sm"
                                  disabled={!draft.trim() && suggestion === null}
                                  onClick={() => add(line)}
                                >
                                  Add to review
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setOpen(null)}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

const NO_RUNS: Map<number, CodeRun[]> = new Map();

function Row(props: {
  line: DiffLine;
  /** The line's text by kind of token, once its language was read. */
  runs: CodeRun[] | undefined;
  onOpen: (() => void) | undefined;
}) {
  const { line } = props;
  if (line.kind === "hunk") {
    return (
      <tr className="diff-hunk">
        <td colSpan={3}>{line.text}</td>
      </tr>
    );
  }
  const comment = (n: number) =>
    props.onOpen ? (
      <button
        type="button"
        className="diff-add-comment"
        aria-label={`Comment on ${lineName(line)}`}
        onClick={props.onOpen}
      >
        {n}
      </button>
    ) : (
      n
    );
  // The button sits on the number its comment anchors to: old for a removed line, new otherwise.
  return (
    <tr className={`diff-${line.kind}`}>
      <td className="diff-no">
        {line.kind === "del" ? comment(line.old) : line.kind === "context" ? line.old : ""}
      </td>
      <td className="diff-no">{line.kind === "del" ? "" : comment(line.new)}</td>
      <td className="diff-code">
        <span className="diff-sign" aria-hidden="true">
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
        </span>
        {props.runs
          ? props.runs.map((run, i) =>
              run.kind ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: a line's runs have no id; their order is fixed.
                <span key={i} className={`tok-${run.kind}`}>
                  {run.text}
                </span>
              ) : (
                run.text
              ),
            )
          : line.text}
      </td>
    </tr>
  );
}
