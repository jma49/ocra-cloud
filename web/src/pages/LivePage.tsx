import CircleCheck from "lucide-react/icons/circle-check";
import EyeOff from "lucide-react/icons/eye-off";
import Radio from "lucide-react/icons/radio";
import Share2 from "lucide-react/icons/share-2";
import Trash2 from "lucide-react/icons/trash-2";
import { useMemo, useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { LiveCommentView, LiveRunView } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { CopyButton } from "../copy-button.js";
import { ago, sourceLabel, time, usd } from "../format.js";
import { CommentThread } from "../live/comments.js";
import { LiveFindingEvent } from "../live/finding.js";
import { shownFindings } from "../live/fold.js";
import { LiveStages } from "../live/progress.js";
import { ShareDrawer } from "../live/share-drawer.js";
import { LiveTasks } from "../live/tasks.js";
import { linkKey, useLive } from "../live/use-live.js";
import { PlatformMark } from "../platform-mark.js";
import { pullPath } from "../pull/path.js";
import { Link, navigate } from "../router.js";
import { SeverityCounts } from "../severity.js";
import { ActionError, EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";
import { VerdictStatus } from "../verdict-status.js";

// A review watched while it runs (ADR-0056): its properties and where it is
// on the left, like a finished review's page; its findings (the confirmed
// ones while it runs, all of them once it ended) and then the discussion on
// the right. The owner shares it from here; people it is shared with watch,
// and comment when allowed.

const RANK = { critical: 0, warning: 1, suggestion: 2 } as const;

const STATE = {
  running: { label: "Running", tone: "run" },
  finished: { label: "Finished", tone: "ok" },
  failed: { label: "Stopped", tone: "err" },
} as const;

export function LivePage(props: { id: string }) {
  const key = useMemo(linkKey, []);
  const { run, progress, comments } = useLive(props.id, key);
  const [sharing, setSharing] = useState(false);
  const [share, setShare] = useState(run.data?.share);
  const [confirming, setConfirming] = useState(false);
  const remove = useAction(() => api(`/live/${props.id}`, { method: "DELETE" }));

  const byFinding = useMemo(() => {
    const map = new Map<string | null, LiveCommentView[]>();
    for (const c of comments.all) map.set(c.findingId, [...(map.get(c.findingId) ?? []), c]);
    return map;
  }, [comments.all]);
  if (run.error && !run.data) {
    if (run.error instanceof ApiError && run.error.status === 404) return <NotShared />;
    return (
      <>
        <PageHead title="Live review" />
        <LoadError what="this run" error={run.error} retry={run.reload} />
      </>
    );
  }
  if (!run.data) {
    return (
      <>
        <PageHead title="Live review" />
        <Loading what="the run" />
      </>
    );
  }
  const r = run.data.run;
  const owner = r.access === "owner";
  const canComment = r.access !== "watch";
  const ended = progress.ending !== null || r.state !== "running";
  const { shown, checking } = shownFindings(progress, ended);
  const findings = shown.sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file),
  );
  const state =
    STATE[
      progress.ending?.kind === "failed" || r.state === "failed"
        ? "failed"
        : ended
          ? "finished"
          : "running"
    ];
  const currentShare = share ?? run.data.share;
  const general = byFinding.get(null) ?? [];
  const actions = { add: comments.add, remove: comments.remove };

  const pull =
    r.source !== "local" && r.repo && r.prNumber
      ? { platform: r.source, repo: r.repo, number: r.prNumber }
      : null;
  const counts = { critical: 0, warning: 0, suggestion: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return (
    <div className="live-frame">
      <aside className="live-side" aria-label="Progress">
        <dl className="prop-list">
          <dt>Status</dt>
          <dd>
            <Status tone={state.tone}>{state.label}</Status>
          </dd>
          {progress.ending?.kind === "finished" && (
            <>
              <dt>Verdict</dt>
              <dd>
                <VerdictStatus
                  verdict={progress.ending.verdict}
                  complete={progress.ending.complete}
                />
              </dd>
            </>
          )}
          {ended && (
            <>
              <dt>Findings</dt>
              <dd>
                <SeverityCounts counts={counts} />
              </dd>
            </>
          )}
          {pull ? (
            <>
              <dt>{pull.platform === "gitlab" ? "Merge request" : "Pull request"}</dt>
              <dd className="prop-pull">
                <PlatformMark platform={pull.platform} size={14} />
                <Link to={pullPath(pull.platform, pull.repo, pull.number)}>
                  {pull.repo} <span className="subtle">#{pull.number}</span>
                </Link>
              </dd>
            </>
          ) : (
            <>
              <dt>Repository</dt>
              <dd>{r.repo ?? "Unnamed"}</dd>
              <dt>Source</dt>
              <dd>{sourceLabel(r.source)}</dd>
            </>
          )}
          <dt>Started</dt>
          <dd>
            <time dateTime={r.createdAt}>{time(r.createdAt)}</time>
            <span className="subtle"> · {ago(r.createdAt)}</span>
          </dd>
          <dt>Owner</dt>
          <dd>{owner ? "You" : r.owner}</dd>
          <dt>Spent</dt>
          <dd>{usd(progress.costUsd)}</dd>
          <dt>Run</dt>
          <dd className="prop-copy">
            <span className="mono subtle prop-copy-text" title={r.runId}>
              {r.runId}
            </span>
            <CopyButton text={r.runId} label="Copy run id" iconOnly />
          </dd>
        </dl>
        <LiveStages progress={progress} ended={ended} />
        <LiveTasks progress={progress} ended={ended} />
        {owner && (
          <div className="prop-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => setSharing(true)}>
              <Share2 aria-hidden="true" />
              Share
            </Button>
            {confirming ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={remove.busy}
                  onClick={async () => {
                    if (await remove.run()) navigate("/live");
                  }}
                >
                  Delete run
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            )}
          </div>
        )}
        {remove.error !== null && <ActionError what="delete the run" error={remove.error} />}
      </aside>

      <section className="live-main" aria-label="Findings">
        <div className="review-title">
          <span className="subtle small">{headline(r)}</span>
          <h1>{r.title || progress.target || r.target || "Review"}</h1>
        </div>
        <div className="review-tabs">
          <span className="quiet-label" role="status">
            {ended
              ? `${findings.length} finding${findings.length === 1 ? "" : "s"}`
              : [
                  findings.length > 0 || checking === 0
                    ? `${findings.length} confirmed so far`
                    : null,
                  checking > 0
                    ? `${checking} ${findings.length > 0 ? "more " : ""}being checked`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </div>
        {findings.length === 0 ? (
          <p className={`live-empty${ended ? " is-done" : ""}`}>
            {ended ? (
              <CircleCheck size={16} aria-hidden="true" />
            ) : (
              <Radio size={16} aria-hidden="true" />
            )}
            <span>
              <strong>{ended ? "No findings" : "No confirmed findings yet"}</strong>
              <span className="subtle">
                {ended
                  ? "The review ended without a finding."
                  : "A critical finding appears here as soon as it is confirmed; the rest follow when the review ends."}
              </span>
            </span>
          </p>
        ) : (
          <ol className="timeline">
            {findings.map((f) => (
              <LiveFindingEvent
                key={f.id}
                f={f}
                comments={byFinding.get(f.id) ?? []}
                canComment={canComment}
                actions={actions}
              />
            ))}
          </ol>
        )}
        {progress.warnings.length > 0 && (
          <div className="note">
            {progress.warnings.map((w) => (
              <p key={w} className="m-0">
                {w}
              </p>
            ))}
          </div>
        )}
        <section className="live-talk" aria-label="Discussion">
          <h2>
            Discussion
            {general.length > 0 && <span className="subtle">{general.length}</span>}
          </h2>
          {comments.list.error && !comments.list.data ? (
            <LoadError
              what="the comments"
              error={comments.list.error}
              retry={comments.list.reload}
            />
          ) : (
            <CommentThread
              comments={general}
              findingId={null}
              canComment={canComment}
              actions={actions}
              placeholder="Comment on this run"
            />
          )}
          {!canComment && (
            <p className="subtle small m-0">
              You can watch this run. Ask its owner to let you comment.
            </p>
          )}
        </section>
      </section>

      {sharing && currentShare && (
        <ShareDrawer
          id={props.id}
          share={currentShare}
          onChange={setShare}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}

const headline = (r: LiveRunView) =>
  [r.repo, r.prNumber ? `#${r.prNumber}` : null].filter(Boolean).join(" ") || sourceLabel(r.source);

function NotShared() {
  return (
    <>
      <PageHead title="Live review" />
      <div className="card">
        <EmptyState
          icon={EyeOff}
          title="This run isn't shared with you"
          action={
            <Button variant="outline" render={<Link to="/live" />}>
              Live reviews
            </Button>
          }
        >
          Ask its owner to add you, or to send its link again. Runs are kept for 90 days.
        </EmptyState>
      </div>
    </>
  );
}
