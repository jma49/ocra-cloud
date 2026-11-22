import Check from "lucide-react/icons/check";
import type { PullFilesView } from "../../../src/shared/index.js";
import { splitPath } from "./diff.js";

type File = PullFilesView["files"][number];

/** The changed files beside the diff: how many are viewed, and a link to each with its tick. */
export function FileList(props: { files: File[]; isViewed: (f: File) => boolean }) {
  const viewed = props.files.filter(props.isViewed).length;
  return (
    <nav className="card file-list" aria-label="Changed files">
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
      {props.files.map((f) => {
        const { dir, name } = splitPath(f.path);
        const done = props.isViewed(f);
        return (
          <a
            key={f.path}
            className={`file-link${done ? " is-viewed" : ""}`}
            href={`#file-${f.path}`}
            title={done ? `${f.path} (viewed)` : f.path}
          >
            <span className="file-tick" aria-hidden="true">
              {done && <Check size={12} />}
            </span>
            {/* The box is right to left so a long path loses its start, not its name;
                the path itself stays left to right, or a leading "." moves to the end. */}
            <span className="file-name">
              <bdi dir="ltr">
                <span className="subtle">{dir}</span>
                {name}
              </bdi>
            </span>
            <span className="diff-count small">
              <span className="add-n">+{f.additions}</span>{" "}
              <span className="del-n">−{f.deletions}</span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
