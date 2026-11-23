import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  LineComment,
  MergeQueueView,
  PullActionOutcome,
  PullDescriptionDraftView,
  PullFilesView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useFixes } from "../fixes/use-fixes.js";
import { count } from "../format.js";
import { usePageCommands } from "../page-commands.js";
import { PlatformMark } from "../platform-mark.js";
import { SinceBar, sinceFiles, useSince } from "../pull/changes-since.js";
import { ChecksBox } from "../pull/checks-box.js";
import { MERGE_ID, pullCommands } from "../pull/commands.js";
import { DescriptionBox } from "../pull/description-box.js";
import { DraftToggle } from "../pull/draft-toggle.js";
import { FileDiff } from "../pull/file-diff.js";
import { FileList } from "../pull/file-list.js";
import { usePullFindings } from "../pull/findings.js";
import { GenerateBox } from "../pull/generate-box.js";
import { JumpToCode } from "../pull/jump-to-code.js";
import { LabelsBox } from "../pull/labels-box.js";
import { MergeBox } from "../pull/merge-box.js";
import { methodLabels } from "../pull/merge-method.js";
import { MergeWhenReadyBox } from "../pull/merge-when-ready-box.js";
import { OcraReviewBox } from "../pull/ocra-review-box.js";
import { OUTCOME } from "../pull/outcome.js";
import { QueueBox } from "../pull/queue-box.js";
import { ReadinessBox, useReadiness } from "../pull/readiness-box.js";
import { ReviewBox } from "../pull/review-box.js";
import { ReviewNowBox } from "../pull/review-now-box.js";
import { ReviewersPanel } from "../pull/reviewers.js";
import { StackPanel } from "../pull/stack.js";
import { nextStep, PullStatus } from "../pull/status.js";
import { ThreadsPanel } from "../pull/threads.js";
import { setPageTitle } from "../title.js";
import { LoadError, Loading, PageHead, useLoad } from "../ui.js";

// A pull request in the console: its changed files read live from the
// platform as the signed-in user, and their review, comment and merge sent
// back as them. Writes name the head the page read, so a pull request that
// moved since is refused rather than reviewed or merged blind.

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
  const since = useSince(query.toString());
  const compared = since.ready;
  useEffect(() => {
    // The comparison reads the last visit's mark, so it goes first.
    if (!updatedAt || !compared) return;
    const mark = { platform, repo, number, updatedAt, head };
    api("/pulls/seen", { method: "POST", body: JSON.stringify(mark) }).catch(() => undefined);
  }, [platform, repo, number, updatedAt, head, compared]);
  const fixes = useFixes(head ? `/pulls/fixes?${query}&head=${head}` : null);
  const found = usePullFindings(head ? `/pulls/findings?${query}&head=${head}` : null);
  const queue = useLoad(() => api<MergeQueueView>(`/pulls/queue?${query}`), [query.toString()]);
  // Ticks sent from this page, over what the page read; a new head reads them afresh.
  const [ticked, setTicked] = useState<{ head: string; paths: ReadonlyMap<string, boolean> }>({
    head: "",
    paths: new Map(),
  });
  const [pending, setPending] = useState<LineComment[]>([]);
  const [said, setSaid] = useState<{ what: string; outcome: PullActionOutcome } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const readiness = useReadiness(ref, head);
  const description = useLoad(
    () =>
      head
        ? api<PullDescriptionDraftView>(`/pulls/description-draft?${query}`)
        : Promise.resolve(undefined),
    [query.toString(), head],
  );
  const code = useRef<HTMLDivElement>(null);
  const where = `${props.repo} #${props.number}`;
  const title = data?.title ?? where;
  useEffect(() => {
    if (data?.title) setPageTitle(`#${props.number} ${data.title}`);
  }, [data?.title, props.number]);
  usePageCommands(
    "This pull request",
    pullCommands({ data, code, review: () => setReviewing(true) }),
  );
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
  const read = new Map(data.files.map((f) => [f.path, f.viewed === true]));
  const isViewed = (f: { path: string }) => sent.get(f.path) ?? read.get(f.path) === true;
  const narrowed = sinceFiles(since);
  const shown = narrowed ?? data.files;
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
  const step = nextStep(readiness, data.mergeMethods.length > 0 && !queue.data?.enabled);
  return (
    <>
      <header className="pull-head">
        <div className="pull-head-row">
          <h1>{title}</h1>
          <div className="pull-actions">
            <PullStatus state={data.state} view={readiness} />
            {data.verdicts.length > 0 && (
              <Button
                size="sm"
                variant={step === "review" && !settled ? "default" : "outline"}
                onClick={() => setReviewing(true)}
              >
                Review changes
                {pending.length > 0 && <span className="num">{pending.length}</span>}
              </Button>
            )}
            {!settled && (
              <DraftToggle pull={ref} primary={step === "ready"} onDone={(o) => done("Draft", o)} />
            )}
            {!settled && step === "merge" && (
              <Button size="sm" render={<a href={`#${MERGE_ID}`} />}>
                Merge
              </Button>
            )}
          </div>
        </div>
        <p className="pull-meta">
          <PlatformMark platform={platform} size={14} />{" "}
          {data.url ? (
            <a href={data.url} target="_blank" rel="noopener noreferrer">
              {where}
            </a>
          ) : (
            where
          )}
          {data.author && <> · {data.author}</>} · {count(data.files.length, "file")} ·{" "}
          <span className="add-n">+{total.add}</span> <span className="del-n">−{total.del}</span> ·
          head <span className="mono">{data.head.slice(0, 7)}</span>
        </p>
        {said && (
          <p className={said.outcome === "done" ? "note" : "error"} role="status">
            {said.what}: {OUTCOME[said.outcome]}
          </p>
        )}
      </header>
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
      <div className="pull-overview">
        <div className="pull-about">
          <StackPanel pull={ref} mergeMethods={data.mergeMethods} onMerged={reload} />
          <DescriptionBox
            pull={ref}
            view={description.data}
            editable={!settled}
            onDone={(o) => {
              done("Description", o);
              if (o === "done") description.reload();
            }}
          />
          <ThreadsPanel pull={ref} onDone={(o) => done("Review threads", o)} />
        </div>
        <aside className="pull-rail" aria-label="Status">
          {!settled && <ReadinessBox view={readiness} />}
          <div id={MERGE_ID} className="pull-merge">
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
                    label={methodLabels(ref.platform)}
                  />
                </>
              )
            )}
          </div>
          <OcraReviewBox review={description.data?.review} open={found.findings.length}>
            {props.runner && !settled ? <ReviewNowBox pull={ref} head={data.head} /> : undefined}
          </OcraReviewBox>
          <ChecksBox pull={ref} head={data.head} />
          <ReviewersPanel pull={ref} />
          <LabelsBox pull={ref} onDone={(o) => done("Labels", o)} />
          {props.runner && !settled && <GenerateBox pull={ref} head={data.head} />}
        </aside>
      </div>
      <div className="pull-frame" ref={code}>
        <aside className="pull-side">
          <FileList files={shown} isViewed={isViewed} />
        </aside>
        <div className="pull-main">
          <SinceBar since={since} />
          {shown.map((f) => (
            <FileDiff
              key={`${since.picked ?? ""}:${f.path}`}
              readOnly={narrowed !== null}
              file={f}
              viewed={isViewed(f)}
              onViewed={(v) => markViewed(f.path, v)}
              pending={pending}
              onComment={(c) => setPending([...pending, c])}
              onDrop={(c) => setPending(pending.filter((x) => x !== c))}
              findings={narrowed === null ? found.findings.filter((x) => x.file === f.path) : []}
              review={found.review?.id ?? null}
              fixes={narrowed === null ? fixes.filter((x) => x.file === f.path) : []}
              onFixDone={(o) => done("Fix", o)}
            />
          ))}
        </div>
      </div>
      <JumpToCode target={code} />
      <ReviewBox
        data={data}
        pull={ref}
        pending={pending}
        wholeDiff={narrowed === null}
        open={reviewing}
        onClose={() => setReviewing(false)}
        onDone={(o) => done("Review", o)}
      />
    </>
  );
}
