import CircleCheck from "lucide-react/icons/circle-check";
import EyeOff from "lucide-react/icons/eye-off";
import Radio from "lucide-react/icons/radio";
import Share2 from "lucide-react/icons/share-2";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { LiveCommentView, LiveRunView } from "../../../src/shared/index.js";
import { ApiError, api } from "../api.js";
import { sourceLabel, time } from "../format.js";
import { CommentThread } from "../live/comments.js";
import { LiveFindingEvent } from "../live/finding.js";
import { LiveCounts, LiveStages } from "../live/progress.js";
import { ShareDrawer } from "../live/share-drawer.js";
import { linkKey, useLive } from "../live/use-live.js";
import { Link, navigate } from "../router.js";
import { ActionError, EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";

// A review watched while it runs (ADR-0056): where it is on the left, its
// findings as they arrive in the middle, the discussion on the right. The
// owner shares it from here; people it is shared with watch, and comment
// when allowed.

const RANK = { critical: 0, warning: 1, suggestion: 2 } as const;

const STATE = {
  running: { label: "Running", cls: "badge-run" },
  finished: { label: "Finished", cls: "badge-ok" },
  failed: { label: "Stopped", cls: "badge-err" },
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
  const findings = useMemo(
    () =>
      [...progress.findings.values()].sort(
        (a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file),
      ),
    [progress.findings],
  );

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

  return (
    <div className="live-frame">
      <aside className="live-side" aria-label="Progress">
        <div className="live-state">
          <span className={`badge ${state.cls}`}>{state.label}</span>
          {progress.ending?.kind === "finished" && (
            <span className="capitalize">{progress.ending.verdict.replaceAll("_", " ")}</span>
          )}
        </div>
        <LiveStages progress={progress} ended={ended} />
        <dl className="prop-list">
          <LiveCounts progress={progress} />
          <dt>Repository</dt>
          <dd className="mono">{r.repo ?? "Unnamed"}</dd>
          <dt>Source</dt>
          <dd>{sourceLabel(r.source)}</dd>
          <dt>Started</dt>
          <dd>{time(r.createdAt)}</dd>
          <dt>Owner</dt>
          <dd>{owner ? "You" : r.owner}</dd>
          <dt>Run</dt>
          <dd className="mono">{r.runId}</dd>
        </dl>
        {owner && (
          <div className="prop-actions">
            <Button type="button" onClick={() => setSharing(true)}>
              <Share2 size={14} strokeWidth={1.75} aria-hidden="true" /> Share
            </Button>
            {confirming ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.busy}
                  onClick={async () => {
                    if (await remove.run()) navigate("/live");
                  }}
                >
                  Confirm: delete run
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="destructive-outline"
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            )}
          </div>
        )}
        {remove.error !== null && <ActionError what="delete the run" error={remove.error} />}
      </aside>

      <section className="live-main" aria-label="Findings">
        <div className="review-title">
          <span className="mono subtle">{headline(r)}</span>
          <h1>{progress.target || r.target || "Review"}</h1>
        </div>
        <div className="review-tabs">
          <span className="quiet-label">
            {findings.length} finding{findings.length === 1 ? "" : "s"}
            {ended ? "" : " so far"}
          </span>
        </div>
        {findings.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={ended ? CircleCheck : Radio}
              title={ended ? "No findings" : "No findings yet"}
            >
              {ended
                ? "The review ended without a finding."
                : "Findings appear here as the reviewers report them."}
            </EmptyState>
          </div>
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
      </section>

      <aside className="live-talk" aria-label="Discussion">
        <h2>Discussion</h2>
        {comments.list.error && !comments.list.data ? (
          <LoadError what="the comments" error={comments.list.error} retry={comments.list.reload} />
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
      </aside>

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
