import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  FixProposalView,
  LineComment,
  PullActionOutcome,
  PullFilesView,
  PullFindingView,
} from "../../../src/shared/index.js";
import { Seg } from "../ui.js";
import { type ContextSource, useContextLines } from "./context-lines.js";
import { anchorOf, type DiffLine, parsePatch, placeOnLines, splitPath } from "./diff.js";
import { DiffRowView, type LineLook } from "./diff-row.js";
import { chunksOf, type DiffLayout, type DiffRow, linesOfRow, rowsOf } from "./diff-rows.js";
import { type WordRange, wordChanges } from "./diff-words.js";
import { FileTypeIcon } from "./file-icon.js";
import { underLine } from "./findings.js";
import { FOLD_LABEL, foldReason } from "./generated.js";
import { type CodeRun, highlightDiff } from "./highlight.js";
import { LazyBody, watchNear } from "./lazy-body.js";
import { CommentBox, hasNotes, LineNotes, type Notes } from "./line-notes.js";
import { isMarkdown, RenderedMarkdown } from "./markdown-view.js";
import type { SearchFocus } from "./use-diff-search.js";

// One changed file of a pull request: its header and its diff, where a
// line's number opens a comment box, and ocra's findings and fixes under the
// lines they are about. Comments wait in the page's review until it is sent.
// The diff is drawn in runs of rows, each only while it is near the window,
// so a pull request of thousands of lines scrolls as lightly as a short one.

type File = PullFilesView["files"][number];

const STATUS: Record<File["status"], string> = {
  added: "Added",
  removed: "Removed",
  modified: "",
  renamed: "Renamed",
};

/** Rows per run drawn or left out as one. */
const RUN = 48;
/** The diff's line height (pages.css `.diff`), and a guess at a note's, until each is measured. */
const ROW_PX = 22;
const NOTE_PX = 160;

const keyOf = (line: DiffLine | undefined) => {
  const a = line && anchorOf(line);
  return a ? `${a.side}:${a.line}` : null;
};

const sameAnchor = (c: LineComment, path: string, line: DiffLine | undefined) => {
  const a = line && anchorOf(line);
  return Boolean(a) && c.path === path && c.line === a?.line && c.side === a?.side;
};

export function FileDiff(props: {
  file: File;
  layout: DiffLayout;
  /** Whether long lines wrap; when not, the diff scrolls sideways. Wraps unless told otherwise. */
  wrap?: boolean;
  viewed: boolean;
  /** Ticks or unticks the file; a tick folds it. */
  onViewed: (viewed: boolean) => void;
  pending: LineComment[];
  onComment: (c: LineComment) => void;
  onDrop: (c: LineComment) => void;
  /** ocra's open findings in this file, and the review they are of. */
  findings: readonly PullFindingView[];
  review: string | null;
  /** A finding marked fixed or dismissed here (true), or put back (false). */
  onDecided: (finding: string, decided: boolean) => void;
  fixes: readonly FixProposalView[];
  onFixDone: (outcome: PullActionOutcome) => void;
  /** Shows the diff without a way to comment on its lines. */
  readOnly?: boolean;
  /** Why the file has no lines, when not for being binary or too large. */
  noPatch?: string | undefined;
  /** Where the lines the diff left out are read; without it they stay out. */
  context?: ContextSource | undefined;
  /** What a find in the diffs found in this file, by the line's index in its patch, and the match shown. */
  found?: ReadonlyMap<number, WordRange[]> | undefined;
  focus?: SearchFocus | null | undefined;
  /** Whether the diff leaves out changes of whitespace alone, so some lines are not in it. */
  hideWhitespace?: boolean;
}) {
  const { file, layout } = props;
  const parsed = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  // Only a file on both sides has unchanged lines to show around its changes.
  const both = file.status === "modified" || file.status === "renamed";
  const reason = foldReason(file.path);
  const [folded, setFolded] = useState(
    file.status === "removed" || props.viewed || reason !== null,
  );
  const [view, setView] = useState<"diff" | "rendered">("diff");
  // A tick, from the box or the page's key, folds the file.
  useEffect(() => {
    if (props.viewed) setFolded(true);
  }, [props.viewed]);
  // The line a comment is being written on, by its anchor: opening lines around it moves its index.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = section.current;
    if (!el || near) return;
    return watchNear(el, (now) => now && setNear(true));
  }, [near]);
  // The file's end is asked for once its diff is open near the window, so no row offers lines it lacks.
  const shown = useContextLines(
    parsed,
    file.path,
    both ? props.context : undefined,
    near && !folded,
  );
  const { lines } = shown;
  const words = useMemo(() => wordChanges(lines), [lines]);
  const rows = useMemo(() => rowsOf(lines, layout), [lines, layout]);
  const fixesAt = useMemo(() => placeOnLines(lines, props.fixes), [lines, props.fixes]);
  const findingsAt = useMemo(
    () => placeOnLines(lines, props.findings.map(underLine)),
    [lines, props.findings],
  );
  const [runs, setRuns] = useState<ReadonlyMap<number, CodeRun[]>>(NO_RUNS);
  useEffect(() => {
    // Colours wait until the file is open and near the window: a long page reads only what is read.
    if (folded || !near) return;
    let live = true;
    // A diff the highlighter cannot read is drawn plain, as it was before.
    highlightDiff(file.path, lines, (part) => live && setRuns(part)).then(
      (r) => live && setRuns(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [folded, near, file.path, lines]);
  const openAt = openKey === null ? -1 : lines.findIndex((l) => keyOf(l) === openKey);
  const open = openAt < 0 ? null : openAt;
  // A find counts lines of the patch; opened lines around them move where each is drawn.
  const drawnAt = useMemo(() => new Map(lines.map((l, i) => [l, i])), [lines]);
  const at = (k: number) => {
    const line = parsed[k];
    return line ? drawnAt.get(line) : undefined;
  };
  const found = useMemo(() => {
    const out = new Map<number, WordRange[]>();
    for (const [k, ranges] of props.found ?? []) {
      const i = drawnAt.get(parsed[k] as DiffLine);
      if (i !== undefined) out.set(i, ranges);
    }
    return out;
  }, [props.found, parsed, drawnAt]);
  const { focus } = props;
  const sought = focus ? (at(focus.line) ?? null) : null;
  // A step to a match here opens the file's diff; once its run is drawn, the match is scrolled to.
  useEffect(() => {
    if (!focus) return;
    setFolded(false);
    setView("diff");
  }, [focus]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each step to the same match scrolls to it again, and a new layout draws it elsewhere.
  useEffect(() => {
    if (sought === null || folded) return;
    section.current?.querySelector(`[data-at="${sought}"]`)?.scrollIntoView({ block: "center" });
  }, [sought, folded, focus?.step, layout]);
  const columns = layout === "split" ? 4 : 3;
  const wrap = props.wrap ?? true;
  // Unwrapped, every run must be as wide as the file's longest line, drawn or not: the width is set from all of them.
  const longest = useMemo(() => (wrap ? 0 : Math.max(0, ...lines.map(widthOf))), [wrap, lines]);
  const look: LineLook = {
    lines,
    runs,
    words,
    onOpen: props.readOnly
      ? undefined
      : (at) => {
          const key = keyOf(lines[at]);
          setOpenKey(key === openKey ? null : key);
        },
    gaps: shown.open,
    expand: shown.expand,
    busy: shown.busy,
    found,
    current: focus && sought !== null ? { at: sought, from: focus.from, to: focus.to } : null,
  };
  const notes: Notes = {
    findingsAt: props.review ? findingsAt : NO_NOTES,
    fixesAt,
    review: props.review,
    onDecided: props.onDecided,
    onFixDone: props.onFixDone,
    // A comment on a line the diff does not draw (a removed line that only re-spaced) waits at its top.
    pendingAt: (at) =>
      at < 0
        ? props.pending.filter(
            (c) => c.path === file.path && !lines.some((l) => sameAnchor(c, file.path, l)),
          )
        : props.pending.filter((c) => sameAnchor(c, file.path, lines[at])),
    onDrop: props.onDrop,
  };
  const chunks = useMemo(() => chunksOf(rows, RUN), [rows]);
  const whitespaceOnly =
    props.hideWhitespace === true &&
    file.additions + file.deletions > 0 &&
    !parsed.some((l) => l.kind === "add" || l.kind === "del");
  const { dir, name } = splitPath(file.path);
  // A Markdown file at the head can also be read as the page it makes; the diff stays the default.
  const page = isMarkdown(file.path) && file.status !== "removed" ? props.context : undefined;
  const rowNotes = (row: DiffRow) =>
    linesOfRow(row).map((at) => (
      <Fragment key={at}>
        <LineNotes at={at} notes={notes} columns={columns} />
        {open === at && lines[at] && (
          <CommentBox
            path={file.path}
            line={lines[at]}
            columns={columns}
            onAdd={(c) => {
              props.onComment(c);
              setOpenKey(null);
            }}
            onCancel={() => setOpenKey(null)}
          />
        )}
      </Fragment>
    ));
  return (
    <section
      ref={section}
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
          {reason && <span className="badge">{FOLD_LABEL[reason]}</span>}
          {/* A file without lines (an image, a binary) has no counts to show. */}
          {file.additions + file.deletions > 0 && (
            <span className="diff-count">
              <span className="add-n">+{file.additions}</span>{" "}
              <span className="del-n">−{file.deletions}</span>
            </span>
          )}
        </button>
        {page && (
          <span className="diff-view">
            <Seg
              label={`Show ${name} as`}
              value={view}
              options={[
                { value: "diff", label: "Diff" },
                { value: "rendered", label: "Rendered" },
              ]}
              onChange={(v) => {
                setView(v);
                setFolded(false);
              }}
            />
          </span>
        )}
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
        (page && view === "rendered" ? (
          <RenderedMarkdown source={page} path={file.path} />
        ) : file.patch === null ? (
          <p className="card-pad subtle small m-0">
            {props.noPatch ?? "The platform sent no diff for this file (binary or too large)."}
          </p>
        ) : whitespaceOnly && !hasNotes(notes, -1) ? (
          <p className="card-pad subtle small m-0">Only whitespace changed in this file.</p>
        ) : (
          <Wide wrap={wrap}>
            <table
              className={`diff diff-main is-${layout}${wrap ? "" : " is-nowrap"}`}
              style={wrap ? undefined : ({ "--line-ch": `${longest}ch` } as React.CSSProperties)}
            >
              <colgroup>
                {layout === "split" ? (
                  <>
                    <col className="diff-no-col" />
                    <col />
                    <col className="diff-no-col" />
                    <col />
                  </>
                ) : (
                  <>
                    <col className="diff-no-col" />
                    <col className="diff-no-col" />
                    <col />
                  </>
                )}
              </colgroup>
              {hasNotes(notes, -1) && (
                <tbody>
                  {props.hideWhitespace && (
                    <tr className="diff-note">
                      <td colSpan={columns} className="subtle small">
                        On lines hidden by the whitespace filter, or not in the diff:
                      </td>
                    </tr>
                  )}
                  <LineNotes at={-1} notes={notes} columns={columns} />
                </tbody>
              )}
              {chunks.map((chunk, k) => {
                const held = chunk.flatMap(linesOfRow);
                const noted = held.filter((at) => hasNotes(notes, at)).length;
                return (
                  <LazyBody
                    // biome-ignore lint/suspicious/noArrayIndexKey: a run is its place in the diff.
                    key={k}
                    columns={columns}
                    estimate={chunk.length * ROW_PX + noted * NOTE_PX}
                    pinned={
                      (open !== null && held.includes(open)) ||
                      (sought !== null && held.includes(sought))
                    }
                  >
                    {() =>
                      chunk.map((row) => (
                        <Fragment key={row.kind === "pair" ? `${row.left}:${row.right}` : row.line}>
                          <DiffRowView row={row} look={look} columns={columns} />
                          {rowNotes(row)}
                        </Fragment>
                      ))
                    }
                  </LazyBody>
                );
              })}
            </table>
          </Wide>
        ))}
    </section>
  );
}

/** Columns a line takes in the code font, a tab counted at its widest. */
const widthOf = (line: DiffLine) => line.text.length + 7 * (line.text.split("\t").length - 1);

/** Unwrapped, a diff scrolls sideways in its own box, under the file's head. */
function Wide(props: { wrap: boolean; children: React.ReactNode }) {
  return props.wrap ? props.children : <div className="diff-wide">{props.children}</div>;
}

const NO_RUNS: ReadonlyMap<number, CodeRun[]> = new Map();
const NO_NOTES: ReadonlyMap<number, PullFindingView[]> = new Map();
