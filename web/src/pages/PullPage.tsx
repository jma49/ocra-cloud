import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { useFixes } from "../fixes/use-fixes.js";
import { count } from "../format.js";
import { PlatformMark } from "../platform-mark.js";
import { ChecksBox } from "../pull/checks-box.js";
import { DescriptionBox } from "../pull/description-box.js";
import { DraftToggle } from "../pull/draft-toggle.js";
import { FileDiff } from "../pull/file-diff.js";
import { FileList } from "../pull/file-list.js";
import { GenerateBox } from "../pull/generate-box.js";
import { LabelsBox } from "../pull/labels-box.js";
import { MergeWhenReadyBox } from "../pull/merge-when-ready-box.js";
import { OUTCOME } from "../pull/outcome.js";
import { QueueBox } from "../pull/queue-box.js";
import { ReadinessBox } from "../pull/readiness-box.js";
import { ReviewNowBox } from "../pull/review-now-box.js";
import { ReviewersPanel } from "../pull/reviewers.js";
import { StackPanel } from "../pull/stack.js";
import { ThreadsPanel } from "../pull/threads.js";
import { setPageTitle } from "../title.js";
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
  // Opening the page marks the pull request read as of what it read; the inbox shows it unread otherwise.
  const { repo } = props;
  const updatedAt = data?.updatedAt;
  const head = data?.head;
  useEffect(() => {
    if (!updatedAt) return;
    const mark = { platform, repo, number, updatedAt, head };
    api("/pulls/seen", { method: "POST", body: JSON.stringify(mark) }).catch(() => undefined);
  }, [platform, repo, number, updatedAt, head]);
  const fixes = useFixes(head ? `/pulls/fixes?${query}&head=${head}` : null);
  const queue = useLoad(() => api<MergeQueueView>(`/pulls/queue?${query}`), [query.toString()]);
  // Ticks sent from this page, over what the page read; a new head reads them afresh.
  const [ticked, setTicked] = useState<{ head: string; paths: ReadonlyMap<string, boolean> }>({
    head: "",
    paths: new Map(),
  });
  const [pending, setPending] = useState<LineComment[]>([]);
  const [said, setSaid] = useState<{ what: string; outcome: PullActionOutcome } | null>(null);
  const where = `${props.repo} #${props.number}`;
  const title = data?.title ?? where;
  useEffect(() => {
    if (data?.title) setPageTitle(`#${props.number} ${data.title}`);
  }, [data?.title, props.number]);
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
    // A committed fix moved the head, and a merge settled the pull request: what the page read is out of date.
    if (outcome === "done" && (what === "Fix" || what === "Merge")) reload();
  };
  const settled = data.state === "merged" || data.state === "closed";
  const sent = ticked.head === data.head ? ticked.paths : new Map<string, boolean>();
  const isViewed = (f: PullFilesView["files"][number]) => sent.get(f.path) ?? f.viewed === true;
  const markViewed = async (path: string, viewed: boolean) => {
    const head = data.head;
    // A path is a map key, never an object's: it may be any name, `__proto__` included.
    const withTick = (keep: boolean) =>
      setTicked((t) => {
        const paths = new Map(t.head === head ? t.paths : []);
        if (keep) paths.set(path, viewed);
        else paths.delete(path);
        return { head, paths };
      });
    withTick(true);
    const r = await post("viewed", { ...ref, head, paths: [path], viewed }).catch(() => undefined);
    if (r?.outcome === "done") return;
    withTick(false);
    if (r) done("Viewed", r.outcome);
  };
  return (
    <>
      <PageHead
        title={title}
        actions={<DraftToggle pull={ref} onDone={(o) => done("Draft", o)} />}
        sub={
          <>
            <PlatformMark platform={platform} size={14} />{" "}
            {data.url ? (
              <a href={data.url} target="_blank" rel="noopener noreferrer">
                {where}
              </a>
            ) : (
              where
            )}
            {data.author && <> · {data.author}</>} · {count(data.files.length, "file")} ·{" "}
            <span className="add-n">+{total.add}</span> <span className="del-n">−{total.del}</span>{" "}
            · head <span className="mono">{data.head.slice(0, 7)}</span>
          </>
        }
      />
      {said && (
        <p className={said.outcome === "done" ? "note" : "error"} role="status">
          {said.what}: {OUTCOME[said.outcome]}
        </p>
      )}
      {settled && (
        <p className="muted small">
          This pull request is {data.state}: you can still comment on it, but not approve or merge
          it.
        </p>
      )}
      {data.truncated && (
        <p className="muted small">
          This pull request has more changes than one page reads; the rest are on the platform.
        </p>
      )}
      <div className="pull-frame">
        <aside className="pull-side">
          <StackPanel pull={ref} mergeMethods={data.mergeMethods} onMerged={reload} />
          <ReviewersPanel pull={ref} />
          <LabelsBox pull={ref} onDone={(o) => done("Labels", o)} />
          <FileList files={data.files} isViewed={isViewed} />
          <ReviewBox data={data} pull={ref} pending={pending} onDone={(o) => done("Review", o)} />
          {!settled && <DescriptionBox pull={ref} onDone={(o) => done("Description", o)} />}
          <ThreadsPanel pull={ref} onDone={(o) => done("Review threads", o)} />
          <ReadinessBox pull={ref} head={data.head} />
          <ChecksBox pull={ref} head={data.head} />
          {props.runner && !settled && <ReviewNowBox pull={ref} head={data.head} />}
          {props.runner && !settled && <GenerateBox pull={ref} head={data.head} />}
          {settled ? null : queue.data?.enabled ? (
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
              <>
                <MergeBox data={data} pull={ref} onDone={(o) => done("Merge", o)} />
                <MergeWhenReadyBox
                  pull={ref}
                  head={data.head}
                  methods={data.mergeMethods}
                  label={METHOD}
                />
              </>
            )
          )}
        </aside>
        <div className="pull-main">
          {data.files.map((f) => (
            <FileDiff
              key={f.path}
              file={f}
              viewed={isViewed(f)}
              onViewed={(v) => markViewed(f.path, v)}
              pending={pending}
              onComment={(c) => setPending([...pending, c])}
              onDrop={(c) => setPending(pending.filter((x) => x !== c))}
              fixes={fixes.filter((x) => x.file === f.path)}
              onFixDone={(o) => done("Fix", o)}
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
      {verdicts.length > 1 && (
        <Seg
          label="Verdict"
          value={verdict}
          onChange={setVerdict}
          options={verdicts.map((v) => ({ value: v, label: VERDICT[v] }))}
        />
      )}
      <textarea
        className="input"
        aria-label="Review note"
        placeholder={
          verdicts.includes("approve") ? "Leave a note (optional for an approval)" : "Leave a note"
        }
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
      <Button disabled={send.busy || empty} onClick={submit}>
        Submit review
      </Button>
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
          <Button className="grow" disabled={merge.busy} onClick={confirm}>
            Confirm: {METHOD[method].toLowerCase()}
          </Button>
          <Button variant="outline" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setAsking(true)}>
          Merge pull request
        </Button>
      )}
      {merge.error !== null && (
        <p className="error" role="alert">
          Could not merge: {why(merge.error)}.
        </p>
      )}
    </section>
  );
}
