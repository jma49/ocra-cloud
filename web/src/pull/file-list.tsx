import Check from "lucide-react/icons/check";
import FileIcon from "lucide-react/icons/file";
import FileMinus from "lucide-react/icons/file-minus";
import FilePlus from "lucide-react/icons/file-plus";
import FolderOpen from "lucide-react/icons/folder-open";
import { useState } from "react";
import type { PullFilesView } from "../../../src/shared/index.js";
import { count } from "../format.js";
import { fileTree } from "./file-tree.js";

type File = PullFilesView["files"][number];

/** Past this many files a field narrows the tree by path. */
const FILTER_FROM = 8;

const MARK: Record<File["status"], { Icon: typeof FileIcon; cls: string; label: string }> = {
  added: { Icon: FilePlus, cls: " is-added", label: "added" },
  removed: { Icon: FileMinus, cls: " is-removed", label: "removed" },
  modified: { Icon: FileIcon, cls: "", label: "changed" },
  renamed: { Icon: FileIcon, cls: "", label: "renamed" },
};

/** The changed files beside the diff, as a tree: how many are viewed, and a link to each. */
export function FileList(props: { files: File[]; isViewed: (f: File) => boolean }) {
  const [filter, setFilter] = useState("");
  const viewed = props.files.filter(props.isViewed).length;
  const wanted = filter.trim().toLowerCase();
  const shown = wanted
    ? props.files.filter((f) => f.path.toLowerCase().includes(wanted))
    : props.files;
  return (
    <nav className="file-list" aria-label="Changed files">
      <div className="file-progress">
        <span className="subtle small">
          {viewed} of {props.files.length} files viewed
        </span>
        <div className="meter" aria-hidden="true">
          <span
            style={{ width: `${props.files.length ? (viewed / props.files.length) * 100 : 0}%` }}
          />
        </div>
      </div>
      {props.files.length >= FILTER_FROM && (
        <input
          className="input file-filter"
          type="search"
          aria-label="Filter files by path"
          placeholder="Filter files"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {wanted && shown.length === 0 && <p className="subtle small file-none">No file matches.</p>}
      {fileTree(shown).map((row) => {
        const indent = { paddingInlineStart: `${8 + row.depth * 16}px` };
        if (row.kind === "dir")
          return (
            <div key={`dir:${row.path}`} className="file-dir" style={indent} title={row.path}>
              <FolderOpen size={14} aria-hidden="true" />
              <span className="file-name">{row.name}</span>
            </div>
          );
        const f = row.file;
        const done = props.isViewed(f);
        const { Icon, cls, label } = MARK[f.status];
        return (
          <a
            key={f.path}
            className={`file-link${cls}${done ? " is-viewed" : ""}`}
            href={`#file-${f.path}`}
            style={indent}
            title={`${f.path} (${label}${done ? ", viewed" : ""})`}
          >
            {done ? (
              <Check className="file-mark" size={14} aria-hidden="true" />
            ) : (
              <Icon className="file-mark" size={14} aria-hidden="true" />
            )}
            <span className="file-name">{row.name}</span>
            <span className="diff-count">
              {f.additions > 0 && <span className="add-n">+{f.additions}</span>}
              {f.additions > 0 && f.deletions > 0 && " "}
              {f.deletions > 0 && <span className="del-n">−{f.deletions}</span>}
            </span>
          </a>
        );
      })}
      {wanted && shown.length > 0 && (
        <p className="subtle small file-none">
          {count(shown.length, "file")} of {props.files.length}
        </p>
      )}
    </nav>
  );
}
