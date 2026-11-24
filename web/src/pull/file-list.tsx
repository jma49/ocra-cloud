import Check from "lucide-react/icons/check";
import type { CSSProperties } from "react";
import type { PullFilesView } from "../../../src/shared/index.js";
import { count } from "../format.js";
import { FileTypeIcon } from "./file-icon.js";
import { fileTree } from "./file-tree.js";
import { FileViewBar } from "./file-view-menu.js";
import { type FileViews, isNarrowed } from "./file-views.js";

type File = PullFilesView["files"][number];

/** From this many files the tree offers its views; with fewer, once this browser keeps one. */
const FILTER_FROM = 8;

/** What happened to a file: the letter after its name, and the word in its title. */
const MARK: Record<File["status"], { letter: string; cls: string; label: string }> = {
  added: { letter: "A", cls: " is-added", label: "added" },
  removed: { letter: "D", cls: " is-removed", label: "removed" },
  modified: { letter: "", cls: "", label: "changed" },
  renamed: { letter: "R", cls: "", label: "renamed" },
};

/**
 * The changed files beside the diff, as a tree: how many are viewed, the
 * view that narrows them, and a link to each file it shows.
 */
export function FileList(props: {
  files: File[];
  /** The files the view keeps, which the diffs show too. */
  shown: File[];
  isViewed: (f: File) => boolean;
  views: FileViews;
}) {
  const { files, shown, views } = props;
  const viewed = files.filter(props.isViewed).length;
  const narrowed = isNarrowed(views.narrowing);
  return (
    <nav className="file-list" aria-label="Changed files">
      <div className="file-progress">
        <span className="subtle small">
          {viewed} of {files.length} files viewed
        </span>
        <div className="meter" aria-hidden="true">
          <span style={{ width: `${files.length ? (viewed / files.length) * 100 : 0}%` }} />
        </div>
      </div>
      {(files.length >= FILTER_FROM || narrowed || views.views.length > 0) && (
        <FileViewBar views={views} />
      )}
      {narrowed && shown.length === 0 && <p className="subtle small file-none">No file matches.</p>}
      {fileTree(shown).map((row) => {
        const indent = { "--depth": row.depth } as CSSProperties;
        if (row.kind === "dir")
          return (
            <div key={`dir:${row.path}`} className="file-dir" style={indent} title={row.path}>
              <FileTypeIcon name={row.name} folder />
              <span className="file-name">{row.name}</span>
            </div>
          );
        const f = row.file;
        const done = props.isViewed(f);
        const { letter, cls, label } = MARK[f.status];
        return (
          <a
            key={f.path}
            className={`file-link${cls}${done ? " is-viewed" : ""}`}
            href={`#file-${f.path}`}
            style={indent}
            title={`${f.path} (${label}${done ? ", viewed" : ""})`}
          >
            <FileTypeIcon name={row.name} />
            <span className="file-name">{row.name}</span>
            {done && <Check className="file-mark" size={14} aria-hidden="true" />}
            {letter && (
              <span className="file-status small" aria-hidden="true">
                {letter}
              </span>
            )}
            <span className="diff-count">
              {f.additions > 0 && <span className="add-n">+{f.additions}</span>}
              {f.additions > 0 && f.deletions > 0 && " "}
              {f.deletions > 0 && <span className="del-n">−{f.deletions}</span>}
            </span>
          </a>
        );
      })}
      {narrowed && shown.length > 0 && (
        <p className="subtle small file-none">
          {count(shown.length, "file")} of {files.length}
        </p>
      )}
    </nav>
  );
}
