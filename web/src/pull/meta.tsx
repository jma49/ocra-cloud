import ArrowRight from "lucide-react/icons/arrow-right";
import type { PullFilesView } from "../../../src/shared/index.js";
import { ago, count } from "../format.js";
import { PersonMark } from "../person-mark.js";

// The line under a pull request's title: who opened it, what it merges into
// what, how much it changes, and when it last moved.

export function PullMeta(props: { data: PullFilesView }) {
  const { data } = props;
  const add = data.files.reduce((n, f) => n + f.additions, 0);
  const del = data.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="pull-meta">
      {data.author && (
        <span className="pull-author-name">
          <PersonMark login={data.author} avatar={data.authorAvatar} />
          {data.author}
        </span>
      )}
      {data.branches ? (
        <span className="pull-branches">
          <span className="branch" title={data.branches.head}>
            {data.branches.head}
          </span>
          <ArrowRight size={14} aria-label="into" />
          <span className="branch" title={data.branches.base}>
            {data.branches.base}
          </span>
        </span>
      ) : (
        <span>
          head <span className="mono">{data.head.slice(0, 7)}</span>
        </span>
      )}
      <span className="pull-size">
        {count(data.files.length, "file")} <span className="add-n">+{add}</span>{" "}
        <span className="del-n">−{del}</span>
      </span>
      {data.updatedAt && <span>Updated {ago(data.updatedAt)}</span>}
    </div>
  );
}
