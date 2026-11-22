import { useState } from "react";
import type {
  CodePlatformKind,
  LineComment,
  MergeMethod,
  MergeQueueView,
  PullActionOutcome,
  PullFilesView,
  PullVerdict,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { splitPath } from "../pull/diff.js";
import { FileDiff } from "../pull/file-diff.js";
import { GenerateBox } from "../pull/generate-box.js";
import { OUTCOME } from "../pull/outcome.js";
import { QueueBox } from "../pull/queue-box.js";
import { LoadError, Loading, PageHead, Seg, useAction, useLoad } from "../ui.js";

// A pull request in the console: its changed files read live from the
// platform as the signed-in user, and their review, comment and merge sent
// back as them. Writes name the head the page read, so a pull request that
// moved since is refused rather than reviewed or merged blind.

const VERDICT: Record<PullVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  request_changes: "Request changes",
};
const METHOD: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

type Answer = { outcome: PullActionOutcome };
const post = (path: string, body: unknown) =>
  api<Answer>(`/pulls/${path}`, { method: "POST", body: JSON.stringify(body) });

export function PullPage(props: {
  platform: string;
  repo: string;
  number: string;
  /** Whether this server runs ocra itself, which writing tests and docstrings needs. */
  runner?: boolean;
}) {
  const platform = props.platform as CodePlatformKind;
  const number = Number(props.number);
  const ref = { platform, repo: props.repo, number };
  const query = new URLSearchParams({ platform, repo: props.repo, number: props.number });
  const { data, error, reload } = useLoad(
    () => api<PullFilesView>(`/pulls/files?${query}`),
    [query.toString()],
  );
  const queue = useLoad(() => api<MergeQueueView>(`/pulls/queue?${query}`), [query.toString()]);
  const [pending, setPending] = useState<LineComment[]>([]);
  const [said, setSaid] = useState<{ what: string; outcome: PullActionOutcome } | null>(null);
  const title = `${props.repo} #${props.number}`;
  if (error && !data) {
    return (
      <>
        <PageHead title={title} />
        <LoadError what="the pull request" error={error} retry={reload} />
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHead title={title} />
        <Loading what="the pull request" />
      </>
    );
  }
  const total = data.files.reduce(
    (n, f) => ({ add: n.add + f.additions, del: n.del + f.deletions }),
    { add: 0, del: 0 },
  );
  const done = (what: string, outcome: PullActionOutcome) => {
    setSaid({ what, outcome });
    if (outcome === "done" && what === "Review") setPending([]);
  };
  return (
    <>
      <PageHead
        title={title}
        sub={
          <>
            {data.files.length} files · <span className="add-n">+{total.add}</span>{" "}
            <span className="del-n">−{total.del}</span> · head{" "}
            <span className="mono">{data.head.slice(0, 7)}</span>
          </>
        }
      />
      {said && (
        <p className={said.outcome === "done" ? "note" : "error"} role="status">
          {said.what}: {OUTCOME[said.outcome]}
        </p>
      )}
      {data.truncated && (
        <p className="muted small">
          This pull request has more changes than one page reads; the rest are on the platform.
        </p>
      )}
      <div className="pull-frame">
        <aside className="pull-side">
          <nav className="card file-list" aria-label="Changed files">
            {data.files.map((f) => {
              const { dir, name } = splitPath(f.path);
              return (
                <a key={f.path} className="file-link" href={`#file-${f.path}`} title={f.path}>
                  <span className="file-name">
                    <span className="subtle">{dir}</span>
                    {name}
                  </span>
                  <span className="diff-count small">
                    <span className="add-n">+{f.additions}</span>{" "}
                    <span className="del-n">−{f.deletions}</span>
                  </span>
                </a>
              );
            })}
          </nav>
          <ReviewBox data={data} pull={ref} pending={pending} onDone={(o) => done("Review", o)} />
          {props.runner && <GenerateBox pull={ref} head={data.head} />}
          {queue.data?.enabled ? (
            <QueueBox
              view={queue.data}
              pull={ref}
              head={data.head}
              onDone={(o) => done("Merge queue", o)}
              reload={queue.reload}
            />
          ) : (
            !queue.loading &&
            data.mergeMethods.length > 0 && (
              <MergeBox data={data} pull={ref} onDone={(o) => done("Merge", o)} />
            )
          )}
        </aside>
        <div className="pull-main">
          {data.files.map((f) => (
            <FileDiff
              key={f.path}
              file={f}
              pending={pending}
              onComment={(c) => setPending([...pending, c])}
              onDrop={(c) => setPending(pending.filter((x) => x !== c))}
            />
          ))}
        </div>
      </div>
    </>
  );
}

type Ref = { platform: CodePlatformKind; repo: string; number: number };

function ReviewBox(props: {
  data: PullFilesView;
  pull: Ref;
  pending: LineComment[];
  onDone: (o: PullActionOutcome) => void;
}) {
  const verdicts = props.data.verdicts;
  const [verdict, setVerdict] = useState<PullVerdict>(verdicts[0] ?? "comment");
  const [body, setBody] = useState("");
  const send = useAction(() =>
    post("review", {
      ...props.pull,
      verdict,
      body,
      head: props.data.head,
      comments: props.pending,
    }),
  );
  const submit = async () => {
    const r = await send.run();
    if (!r) return;
    if (r.outcome === "done") setBody("");
    props.onDone(r.outcome);
  };
  const empty = verdict !== "approve" && !body.trim() && props.pending.length === 0;
  if (verdicts.length === 0) return null;
  return (
    <section className="card card-pad stack" aria-label="Your review">
      <div className="strong">Your review</div>
      <Seg
        label="Verdict"
        value={verdict}
        onChange={setVerdict}
        options={verdicts.map((v) => ({ value: v, label: VERDICT[v] }))}
      />
      <textarea
        className="input"
        aria-label="Review note"
        placeholder="Leave a note (optional for an approval)"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <span className="subtle small">
        {props.pending.length === 0
          ? "Click a line number in the diff to comment on that line."
          : props.pending.length === 1
            ? "1 line comment goes with it."
            : `${props.pending.length} line comments go with it.`}
      </span>
      <button
        type="button"
        className="btn btn-primary"
        disabled={send.busy || empty}
        onClick={submit}
      >
        Submit review
      </button>
      {send.error !== null && (
        <p className="error" role="alert">
          Could not send the review: {why(send.error)}.
        </p>
      )}
    </section>
  );
}

function MergeBox(props: {
  data: PullFilesView;
  pull: Ref;
  onDone: (o: PullActionOutcome) => void;
}) {
  const methods = props.data.mergeMethods;
  const [method, setMethod] = useState<MergeMethod>(methods[0] ?? "merge");
  const [asking, setAsking] = useState(false);
  const merge = useAction(() => post("merge", { ...props.pull, method, head: props.data.head }));
  const confirm = async () => {
    const r = await merge.run();
    setAsking(false);
    if (r) props.onDone(r.outcome);
  };
  return (
    <section className="card card-pad stack" aria-label="Merge">
      <div className="strong">Merge</div>
      <select
        className="input"
        aria-label="Merge method"
        value={method}
        onChange={(e) => setMethod(e.target.value as MergeMethod)}
      >
        {methods.map((m) => (
          <option key={m} value={m}>
            {METHOD[m]}
          </option>
        ))}
      </select>
      {asking ? (
        <div className="row-gap">
          <button
            type="button"
            className="btn btn-primary grow"
            disabled={merge.busy}
            onClick={confirm}
          >
            Confirm: {METHOD[method].toLowerCase()}
          </button>
          <button type="button" className="btn" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setAsking(true)}>
          Merge pull request
        </button>
      )}
      {merge.error !== null && (
        <p className="error" role="alert">
          Could not merge: {why(merge.error)}.
        </p>
      )}
    </section>
  );
}
