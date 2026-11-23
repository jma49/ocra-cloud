import { useCallback, useEffect, useRef, useState } from "react";
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
import { useRead } from "../cache.js";
import { FixJobsOf } from "../fixes/fix-jobs.js";
import { useFixesRead } from "../fixes/use-fixes.js";
import { useBeside } from "../inbox/queue.js";
import { usePageCommands } from "../page-commands.js";
import { PlatformMark } from "../platform-mark.js";
import { PullBatch } from "../pull/batch.js";
import { SinceBar, sinceFiles, useSince } from "../pull/changes-since.js";
import { ChecksBox } from "../pull/checks-box.js";
import { useClearance } from "../pull/clearance.js";
import { MERGE_ID, pullCommands } from "../pull/commands.js";
import { DescriptionBox } from "../pull/description-box.js";
import { DiffBar } from "../pull/diff-bar.js";
import { useDiffLayout } from "../pull/diff-layout.js";
import { DraftToggle } from "../pull/draft-toggle.js";
import { FileDiff } from "../pull/file-diff.js";
import { FileList } from "../pull/file-list.js";
import { treeOrder } from "../pull/file-tree.js";
import { usePullFindings } from "../pull/findings.js";
import { GenerateBox } from "../pull/generate-box.js";
import { useHeadMoved } from "../pull/head-moved.js";
import { JumpToCode } from "../pull/jump-to-code.js";
import { LabelsBox } from "../pull/labels-box.js";
import { MergeCard } from "../pull/merge-card.js";
import { PullMeta } from "../pull/meta.js";
import { OcraCommands } from "../pull/ocra-commands.js";
import { OcraReviewBox } from "../pull/ocra-review-box.js";
import { PullFailed, PullLoading } from "../pull/opening.js";
import { DONE, type Done, OUTCOME } from "../pull/outcome.js";
import { pullPath } from "../pull/path.js";
import { PeopleCard } from "../pull/people.js";
import { QueueBox } from "../pull/queue-box.js";
import { ReadinessBox, useReadiness } from "../pull/readiness-box.js";
import { ReviewBox } from "../pull/review-box.js";
import { ReviewNowBox } from "../pull/review-now-box.js";
import { ReviewersPanel } from "../pull/reviewers.js";
import { StackPanel } from "../pull/stack.js";
import { conflicts, nextStep, PullStatus } from "../pull/status.js";
import { ThreadsPanel } from "../pull/threads.js";
import { UpdateBranch } from "../pull/update-branch.js";
import { useViewed } from "../pull/viewed.js";
import { setPageTitle } from "../title.js";
import { useToast } from "../toast.js";
import { useLoad } from "../ui.js";

// A pull request in the console: its changed files read live from the
// platform as the signed-in user, and their review, comment and merge sent
// back as them. Writes name the head the page read, so a pull request that
// moved since is refused rather than reviewed or merged blind.

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
  // A diff can be large: the last one shown is kept for this tab only.
  const { data, error, reload, stale } = useRead<PullFilesView>(`/pulls/files?${query}`, {
    memoryOnly: true,
  });
  // Opening the page marks the pull request read as of what it read now (not the copy shown
  // while it reads); the inbox shows it unread otherwise.
  const committed = useHeadMoved(data?.head, reload);
  const { repo } = props;
  const updatedAt = stale ? undefined : data?.updatedAt;
  const head = data?.head;
  const since = useSince(query.toString());
  const compared = since.ready;
  useEffect(() => {
    // The comparison reads the last visit's mark, so it goes first.
    if (!updatedAt || !compared) return;
    const mark = { platform, repo, number, updatedAt, head };
    api("/pulls/seen", { method: "POST", body: JSON.stringify(mark) }).catch(() => undefined);
  }, [platform, repo, number, updatedAt, head, compared]);
  const { fixes, reload: readFixes } = useFixesRead(
    head ? `/pulls/fixes?${query}&head=${head}` : null,
  );
  const found = usePullFindings(head ? `/pulls/findings?${query}&head=${head}` : null);
  const readFindings = found.reload;
  const fixProposed = useCallback(() => {
    readFixes();
    readFindings();
  }, [readFixes, readFindings]);
  // Findings marked fixed or dismissed on this page leave its diff at once.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const decide = (id: string, gone: boolean) =>
    setDecided((was) => {
      const now = new Set(was);
      if (gone) now.add(id);
      else now.delete(id);
      return now;
    });
  const findings = found.findings.filter((f) => !decided.has(f.id));
  const queue = useRead<MergeQueueView>(`/pulls/queue?${query}`);
  const [pending, setPending] = useState<LineComment[]>([]);
  const toast = useToast();
  const said = (what: Done, outcome: PullActionOutcome) => {
    if (outcome !== "done") toast(`${what}: ${OUTCOME[outcome]}`, "error");
    else if (DONE[what]) toast(DONE[what], "success");
  };
  const [reviewing, setReviewing] = useState(false);
  const [peopleRev, setPeopleRev] = useState(0);
  const [readinessRev, setReadinessRev] = useState(0);
  const readiness = useReadiness(ref, head, readinessRev);
  const description = useLoad(
    () =>
      head
        ? api<PullDescriptionDraftView>(`/pulls/description-draft?${query}`)
        : Promise.resolve(undefined),
    [query.toString(), head],
  );
  const readDescription = description.reload;
  const reviewed = useCallback(() => {
    readDescription();
    readFindings();
    readFixes();
  }, [readDescription, readFindings, readFixes]);
  const code = useRef<HTMLDivElement>(null);
  const [headEl, setHeadEl] = useState<HTMLElement | null>(null);
  useClearance(headEl);
  const where = `${props.repo} #${props.number}`;
  const title = data?.title ?? where;
  useEffect(() => {
    if (data?.title) setPageTitle(`#${props.number} ${data.title}`);
  }, [data?.title, props.number]);
  const beside = useBeside(pullPath(platform, props.repo, number));
  const viewed = useViewed(ref, data, (o) => said("Viewed", o));
  const layout = useDiffLayout();
  const otherLayout = layout.picked === "split" ? "unified" : "split";
  usePageCommands(
    "This pull request",
    pullCommands({
      data,
      code,
      review: () => setReviewing(true),
      toggleViewed: viewed.toggle,
      switchLayout: layout.narrow
        ? undefined
        : { to: otherLayout, run: () => layout.pick(otherLayout) },
      beside,
    }),
  );
  if (error && !data) {
    return <PullFailed platform={platform} where={where} error={error} retry={reload} />;
  }
  if (!data) return <PullLoading platform={platform} where={where} />;
  const done = (what: Done, outcome: PullActionOutcome) => {
    said(what, outcome);
    if (outcome === "done" && what === "Review") setPending([]);
    // A resolved thread, a review or a draft switch changes what merge readiness counts.
    if (outcome === "done") setReadinessRev((n) => n + 1);
    // A committed fix moves the head, and a merge settled the pull request: what the page read is out of date.
    if (outcome === "done" && what === "Fix") committed();
    if (outcome === "done" && what === "Merge") reload();
  };
  const settled = data.state === "merged" || data.state === "closed";
  const refresh = () => {
    reload();
    setReadinessRev((n) => n + 1);
  };
  const narrowed = sinceFiles(since);
  const shown = treeOrder(narrowed ?? data.files);
  const queues = queue.data?.enabled === true;
  const step = nextStep(
    readiness,
    queues ? queue.data?.entry === null : data.mergeMethods.length > 0,
  );
  return (
    <PullBatch pull={ref} head={data.head} onCommitted={committed}>
      <p className="pull-where">
        <PlatformMark platform={platform} size={14} />
        {data.url ? (
          <a href={data.url} target="_blank" rel="noopener noreferrer">
            {where}
          </a>
        ) : (
          where
        )}
      </p>
      <header className="pull-head" ref={setHeadEl}>
        <div className="pull-head-row">
          <h1>{title}</h1>
          <div className="pull-actions">
            {data.verdicts.length > 0 && (
              <Button
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
              <Button render={<a href={`#${MERGE_ID}`} />}>{queues ? "Queue" : "Merge"}</Button>
            )}
          </div>
        </div>
        <PullMeta
          data={data}
          status={
            <PullStatus
              state={data.state}
              view={readiness}
              queued={queue.data?.entry?.state ?? null}
            />
          }
        />
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
          <StackPanel
            pull={ref}
            mergeMethods={data.mergeMethods}
            onMerged={reload}
            restack={
              !settled &&
              !readiness?.canUpdateBranch && (
                <UpdateBranch pull={ref} head={data.head} onChanged={refresh} bare />
              )
            }
          />
          <DescriptionBox
            pull={ref}
            view={description.data}
            editable={!settled}
            onDone={(o) => {
              done("Description", o);
              if (o === "done") description.reload();
            }}
          />
          <ThreadsPanel
            pull={ref}
            onDone={(o) => done("Review threads", o)}
            onMoved={() => setReadinessRev((n) => n + 1)}
          />
        </div>
        <aside className="pull-rail" aria-label="Status">
          {!settled && (
            <ReadinessBox view={readiness}>
              {readiness?.canUpdateBranch && (
                <UpdateBranch pull={ref} head={data.head} onChanged={refresh} />
              )}
            </ReadinessBox>
          )}
          <div id={MERGE_ID} className="pull-merge">
            {settled ? null : queue.data?.enabled ? (
              <QueueBox
                view={queue.data}
                pull={ref}
                head={data.head}
                primary={step === "merge"}
                unmet={readiness?.ready === "unmet"}
                onDone={(o) => done("Merge queue", o)}
                reload={queue.reload}
                onLeft={refresh}
              />
            ) : (
              !queue.loading &&
              data.mergeMethods.length > 0 && (
                <MergeCard
                  data={data}
                  pull={ref}
                  ready={step === "merge"}
                  conflicts={conflicts(readiness)}
                  onDone={(o) => done("Merge", o)}
                />
              )
            )}
          </div>
          <OcraReviewBox review={description.data?.review} open={findings.length}>
            {props.runner && !settled ? (
              <>
                <ReviewNowBox pull={ref} head={data.head} onReviewed={reviewed} />
                <OcraCommands pull={ref} />
              </>
            ) : undefined}
          </OcraReviewBox>
          <ChecksBox pull={ref} head={data.head} />
          <PeopleCard
            pull={ref}
            editable={!settled}
            rev={peopleRev}
            onChanged={() => setPeopleRev((n) => n + 1)}
          />
          <ReviewersPanel pull={ref} rev={peopleRev} onChanged={() => setPeopleRev((n) => n + 1)} />
          <LabelsBox pull={ref} onDone={(o) => done("Labels", o)} />
          {props.runner && !settled && <GenerateBox pull={ref} head={data.head} />}
        </aside>
      </div>
      <div className="pull-frame" ref={code}>
        <aside className="pull-side">
          <FileList files={shown} isViewed={(f) => viewed.isViewed(f.path)} />
        </aside>
        <div className="pull-main">
          <DiffBar layout={layout} />
          <SinceBar since={since} />
          <FixJobsOf query={query.toString()} onProposed={fixProposed}>
            {shown.map((f) => (
              <FileDiff
                key={`${since.picked ?? ""}:${f.path}`}
                layout={layout.drawn}
                context={{ pull: ref, head: data.head }}
                readOnly={narrowed !== null}
                file={f}
                viewed={viewed.isViewed(f.path)}
                onViewed={(v) => viewed.mark(f.path, v)}
                pending={pending}
                onComment={(c) => setPending([...pending, c])}
                onDrop={(c) => setPending(pending.filter((x) => x !== c))}
                findings={narrowed === null ? findings.filter((x) => x.file === f.path) : []}
                review={found.review?.id ?? null}
                onDecided={decide}
                fixes={
                  narrowed === null
                    ? fixes.filter((x) => x.file === f.path && !decided.has(x.finding))
                    : []
                }
                onFixDone={(o) => done("Fix", o)}
              />
            ))}
          </FixJobsOf>
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
    </PullBatch>
  );
}
