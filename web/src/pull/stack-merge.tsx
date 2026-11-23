import Clock from "lucide-react/icons/clock";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  StackMergeAnswer,
  StackMergeJobView,
  StackMergeReason,
  StackMergeState,
  StackStepOutcome,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { ago } from "../format.js";
import { CloseGlyph, DoneGlyph } from "../glyphs.js";
import { Link } from "../router.js";
import { useAction, usePoll } from "../ui.js";
import { OUTCOME } from "./outcome.js";
import { pullPath } from "./path.js";
import { Tally } from "./tally.js";

// A stack merge the server runs layer by layer, read again while it is under
// way: where each layer stands, what the one it is on waits for, and a way
// to stop it.

const STEP: Record<StackStepOutcome, string> = {
  ...OUTCOME,
  unreached: "The platform did not answer.",
};

const REASON: Record<StackMergeReason, string> = {
  waiting_checks: "Waiting for its checks.",
  waiting_platform: "Waiting until the platform allows the merge (approvals, rules).",
  updating: "Bringing its branch up to date with the trunk.",
  checks_failed: "Stopped: a check failed.",
  conflicts: "Stopped: it conflicts with the trunk.",
  refused: "Stopped: the platform refused it. Check your permission on the repository.",
  head_moved: "Stopped: it gained commits since the merge started.",
  closed: "Stopped: it was closed.",
  stack_changed: "Stopped: the stack changed on the platform.",
  no_token: "Stopped: connect the platform again.",
  unreachable: "The platform did not answer; trying again.",
  timed_out: "Stopped: it waited too long.",
};

const STANDING: Record<StackMergeState, { text: string; tone: string }> = {
  waiting: { text: "Waiting", tone: "badge" },
  running: { text: "Merging", tone: "badge badge-run" },
  merged: { text: "Merged", tone: "badge badge-ok" },
  failed: { text: "Stopped", tone: "badge badge-err" },
  cancelled: { text: "Cancelled", tone: "badge" },
};

const POLL_MS = 5000;

export const stackMergeActive = (job: StackMergeJobView) =>
  job.state === "waiting" || job.state === "running";

type LayerState = "merged" | "current" | "failed" | "next" | "left";

const MARK: Record<LayerState, { label: string; cls: string }> = {
  merged: { label: "Merged", cls: "ok" },
  current: { label: "Under way", cls: "wait" },
  failed: { label: "Stopped", cls: "err" },
  next: { label: "Next", cls: "muted" },
  left: { label: "Not merged", cls: "muted" },
};

function layerState(job: StackMergeJobView, i: number): LayerState {
  if (i < job.step || job.state === "merged") return "merged";
  const active = stackMergeActive(job);
  if (i > job.step) return active ? "next" : "left";
  if (active) return "current";
  return job.state === "failed" ? "failed" : "left";
}

function layerText(job: StackMergeJobView, state: LayerState): string {
  if (state === "merged") return "Merged.";
  if (state === "next") return "Next.";
  if (state === "current" || state === "failed") {
    return job.reason ? REASON[job.reason] : "Merging.";
  }
  return job.state === "cancelled" ? "Cancelled." : "Not merged.";
}

function Mark(props: { state: LayerState; label?: string }) {
  const mark = MARK[props.state];
  return (
    <span className={`check-mark ${mark.cls}`} role="img" aria-label={props.label ?? mark.label}>
      {props.state === "merged" && <DoneGlyph size={14} />}
      {props.state === "failed" && <CloseGlyph size={14} />}
      {props.state === "current" && <Clock size={13} aria-hidden="true" />}
    </span>
  );
}

export function StackMergeJob(props: {
  job: StackMergeJobView;
  /** Titles of the pull requests the page knows, by number. */
  titles?: ReadonlyMap<number, string>;
  /** A layer landed: what the page shows is out of date. */
  onMerged: () => void;
}) {
  const [job, setJob] = useState(props.job);
  const { platform, repo, bottom, step } = job;
  const query = new URLSearchParams({ platform, repo, number: String(bottom) }).toString();
  const active = stackMergeActive(job);
  const { onMerged } = props;
  useEffect(() => {
    if (step > 0) onMerged();
  }, [step, onMerged]);
  const read = useCallback(async () => {
    const r = await api<StackMergeAnswer>(`/pulls/merge-stack?${query}`).catch(() => null);
    if (r?.job) setJob(r.job);
  }, [query]);
  usePoll(active, read, POLL_MS);
  const cancel = useAction(async () => {
    const r = await api<StackMergeAnswer>("/pulls/merge-stack", {
      method: "DELETE",
      body: JSON.stringify({ platform, repo, number: bottom }),
    });
    if (r.job) setJob(r.job);
  });
  const layers = job.chain.map((l, i) => ({ ...l, state: layerState(job, i) }));
  const merged = layers.filter((l) => l.state === "merged").length;
  // Squashed or rebased layers land as new commits, so a branch built on the old ones still carries them.
  const stale = job.method !== "merge" && job.restacked.some((s) => s.outcome === "done");
  const s = STANDING[job.state];
  return (
    <section className="card card-pad stack" aria-label="Stack">
      <div className="row-gap checks-head">
        <span className="strong grow">Stack merge</span>
        <span className={s.tone}>{s.text}</span>
      </div>
      <Tally
        label={`${merged} of ${layers.length} merged`}
        parts={[
          { tone: "ok", n: merged },
          { tone: "err", n: layers.filter((l) => l.state === "failed").length },
          {
            tone: "wait",
            n: layers.filter((l) => l.state !== "merged" && l.state !== "failed").length,
          },
        ]}
      />
      <ul className="check-results" role="status">
        {layers.map((l) => (
          <li key={l.number}>
            <Mark state={l.state} />
            <div>
              <Link to={pullPath(platform, repo, l.number)} className="stack-merge-layer">
                <span className="mono subtle">#{l.number}</span>
                <span className="pull-stack-title">{props.titles?.get(l.number)}</span>
              </Link>
              <div className={l.state === "failed" ? "error small" : "subtle small"}>
                {layerText(job, l.state)}
              </div>
            </div>
          </li>
        ))}
        {job.restacked.map((r) => (
          <li key={r.number}>
            <Mark
              state={r.outcome === "done" ? "merged" : "failed"}
              label={r.outcome === "done" ? "Moved onto the trunk" : "Not moved"}
            />
            <div>
              <Link to={pullPath(platform, repo, r.number)} className="stack-merge-layer">
                <span className="mono subtle">#{r.number}</span>
                <span className="pull-stack-title">{props.titles?.get(r.number)}</span>
              </Link>
              <div className={r.outcome === "done" ? "subtle small" : "error small"}>
                {r.outcome === "done" ? (
                  <>
                    Now onto <span className="mono">{job.trunk}</span>.
                  </>
                ) : (
                  <>Still on a merged branch: {STEP[r.outcome]}</>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <span className="subtle small">
        Started by {job.startedBy} {ago(job.startedAt)}.
        {active && " It runs on the server, and moves along sooner while this page is open."}
      </span>
      {active && (
        <Button
          variant="outline"
          className="stack-merge-stop"
          loading={cancel.busy}
          onClick={() => cancel.run()}
        >
          Stop the stack merge
        </Button>
      )}
      {cancel.error !== null && (
        <p className="error" role="alert">
          Could not stop it: {why(cancel.error)}.
        </p>
      )}
      {stale && (
        <span className="subtle small">
          Their branches still hold the merged commits, so their diffs list those changes too. Run{" "}
          <span className="mono">ocra stack sync</span> then{" "}
          <span className="mono">ocra stack submit</span> to rebase and push them.
        </span>
      )}
    </section>
  );
}
