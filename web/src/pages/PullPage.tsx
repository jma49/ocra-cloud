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
import { ResolveConflicts } from "../fixes/resolve-conflicts.js";
import { useFixesRead } from "../fixes/use-fixes.js";
import { useBeside } from "../inbox/queue.js";
import { usePageCommands } from "../page-commands.js";
import { PlatformMark } from "../platform-mark.js";
import { PullBatch } from "../pull/batch.js";
import { SinceBar, sinceFiles, useSince } from "../pull/changes-since.js";
import { ChecksBox } from "../pull/checks-box.js";
import { useClearance } from "../pull/clearance.js";
import { MERGE_ID, pullCommands } from "../pull/commands.js";
import { CompactBar } from "../pull/compact-bar.js";
import { DescriptionBox } from "../pull/description-box.js";
import { DiffBar } from "../pull/diff-bar.js";
import { useDiffLayout, useDiffWhitespace, useDiffWrap, useHeld } from "../pull/diff-layout.js";
import { DraftToggle } from "../pull/draft-toggle.js";
import { EarlierFindings, useEarlierFindings } from "../pull/earlier-findings.js";
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
import { SearchBar } from "../pull/search-bar.js";
import { StackPanel } from "../pull/stack.js";
import { conflicts, nextStep, PullStatus } from "../pull/status.js";
import { ThreadsPanel } from "../pull/threads.js";
import { UpdateBranch } from "../pull/update-branch.js";
import { useDiffSearch } from "../pull/use-diff-search.js";
import { useViewed } from "../pull/viewed.js";
import { rememberPull } from "../recent-pulls.js";
import { setPageTitle } from "../title.js";
import { useToast } from "../toast.js";
import { useLoad } from "../ui.js";

// A pull request in the console: its changed files read live from the
// platform as the signed-in user, and their review, comment and merge sent
// back as them. Writes name the head the page read, so a pull request that
// moved since is refused rather than reviewed or merged blind.

const NO_FILES: PullFilesView["files"] = [];

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
  const whitespace = useDiffWhitespace();
  const filter = whitespace.hidden ? "&whitespace=ignore" : "";
  // A diff can be large: the last one shown is kept for this tab only.
  const read = useRead<PullFilesView>(`/pulls/files?${query}${filter}`, { memoryOnly: true });
  const { error, reload, stale } = read;
  // The diff drawn, and how it was asked for: the last one stays while the other way is read.
  const drawn = useHeld(read.data && { data: read.data, filter }, query.toString());
  const data = drawn?.data;
  // Opening the page marks the pull request read as of what it read now (not the copy shown
  // while it reads); the inbox shows it unread otherwise.
  const committed = useHeadMoved(data?.head, reload);
  const { repo } = props;
  const updatedAt = stale ? undefined : data?.updatedAt;
  const head = data?.head;
  const since = useSince(query.toString(), filter);
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
  const earlier = useEarlierFindings(head ? `/pulls/findings/earlier?${query}&head=${head}` : null);
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
  const [barEl, setBarEl] = useState<HTMLElement | null>(null);
  useClearance(barEl);
  const where = `${props.repo} #${props.number}`;
  const title = data?.title ?? where;
  useEffect(() => {
    if (!data?.title) return;
    setPageTitle(`#${props.number} ${data.title}`);
    rememberPull({ to: pullPath(platform, props.repo, number), title: data.title, ref: where });
  }, [data?.title, props.number, platform, props.repo, number, where]);
  const beside = useBeside(pullPath(platform, props.repo, number));
  const viewed = useViewed(ref, data, (o) => said("Viewed", o));
  const layout = useDiffLayout();
  const wrap = useDiffWrap(layout.narrow);
  const otherLayout = layout.picked === "split" ? "unified" : "split";
  const search = useDiffSearch(sinceFiles(since) ?? data?.files ?? NO_FILES);
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
      whitespace: { hidden: whitespace.hidden, toggle: () => whitespace.pick(!whitespace.hidden) },
      beside,
      say: (text) => toast(text),
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
  const status = (
    <PullStatus state={data.state} view={readiness} queued={queue.data?.entry?.state ?? null} />
  );
  const actions = (
    <>
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
    </>
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
          <div className="pull-actions">{actions}</div>
        </div>
        <PullMeta data={data} status={status} />
      </header>
      <CompactBar
        head={headEl}
        number={props.number}
        title={title}
        status={status}
        actions={actions}
        onAnchor={setBarEl}
      />
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
              {readiness?.items.some((i) => i.kind === "conflicts" && i.state === "unmet") && (
                <ResolveConflicts pull={ref} onChanged={refresh} />
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
          <OcraReviewBox
            review={description.data?.review}
            open={findings.length}
            earlier={<EarlierFindings findings={earlier} />}
          >
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
          <SearchBar search={search} />
          <DiffBar layout={layout} wrap={wrap} whitespace={whitespace} />
          <SinceBar since={since} />
          <FixJobsOf query={query.toString()} onProposed={fixProposed}>
            {shown.map((f) => (
              <FileDiff
                key={`${since.picked ?? ""}:${drawn?.filter}:${f.path}`}
                hideWhitespace={drawn?.filter !== ""}
                layout={layout.drawn}
                wrap={wrap.drawn}
                found={search.found.get(f.path)}
                focus={search.focus?.path === f.path ? search.focus : null}
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
