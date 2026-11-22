import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  FixProposalView,
  LineComment,
  PullActionOutcome,
  PullFilesView,
} from "../../../src/shared/index.js";
import { FixProposal } from "../fixes/fix-proposal.js";
import { anchorOf, type DiffLine, parsePatch, placeOnLines, splitPath } from "./diff.js";
import { SuggestionText } from "./suggestion.js";

// One changed file of a pull request: its header and its diff, where a
// line's number opens a comment box, and ocra's fixes under the lines they
// replace. Comments wait in the page's review until it is sent. Every text
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
  fixes: readonly FixProposalView[];
  onFixDone: (outcome: PullActionOutcome) => void;
}) {
  const { file } = props;
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const fixesAt = useMemo(() => placeOnLines(lines, props.fixes), [lines, props.fixes]);
  const fixRows = (i: number) =>
    fixesAt.get(i)?.map((fix) => (
      <tr key={fix.finding} className="diff-note">
        <td colSpan={3}>
          <FixProposal fix={fix} onDone={props.onFixDone} />
        </td>
      </tr>
    ));
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // A suggestion replaces the commented new line; null while the comment carries none.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [folded, setFolded] = useState(file.status === "removed" || props.viewed);
  const { dir, name } = splitPath(file.path);
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
          <span className="mono diff-path">
            {file.status === "renamed" && <span className="subtle">{file.oldPath} → </span>}
            <span className="subtle">{dir}</span>
            {name}
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
            onChange={(e) => {
              if (e.target.checked) setFolded(true);
              props.onViewed(e.target.checked);
            }}
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
                        onOpen={() => {
                          setOpen(open === i ? null : i);
                          setSuggestion(null);
                        }}
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

function Row(props: { line: DiffLine; onOpen: () => void }) {
  const { line } = props;
  if (line.kind === "hunk") {
    return (
      <tr className="diff-hunk">
        <td colSpan={3}>{line.text}</td>
      </tr>
    );
  }
  const comment = (n: number) => (
    <button
      type="button"
      className="diff-add-comment"
      aria-label={`Comment on ${lineName(line)}`}
      onClick={props.onOpen}
    >
      {n}
    </button>
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
        {line.text}
      </td>
    </tr>
  );
}
