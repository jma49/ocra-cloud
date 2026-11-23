import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodePlatformKind,
  chainTo,
  type MergeMethod,
  type PullStackView,
  type StackedPull,
  type StackMergeAnswer,
  type StackMergeJobView,
  type StackMergeReason,
  type StackStepOutcome,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Link } from "../router.js";
import { useAction, useLoad } from "../ui.js";
import { CheckMark } from "./check-mark.js";
import { stackMethodLabels } from "./merge-method.js";
import { OUTCOME } from "./outcome.js";
import { pullPath } from "./path.js";

// The pull request's stack, read from the platform's branches (ADR-0052):
// each one links to its page, and the stack merges from the bottom up to
// this one, each with the head this page read, as a merge the server runs
// layer by layer while this page reads how far it got.

type Ref = { platform: CodePlatformKind; repo: string; number: number };

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

const ACTIVE = new Set(["waiting", "running"]);
const POLL_MS = 5000;

const depthOf = (pulls: StackedPull[], p: StackedPull) => {
  let depth = 0;
  for (let up = p.parent; up !== null && depth < pulls.length; depth++) {
    up = pulls.find((q) => q.number === up)?.parent ?? null;
  }
  return depth;
};

export function StackPanel(props: {
  pull: Ref;
  mergeMethods: MergeMethod[];
  /** After a stack merge that landed any pull request: what the page shows is out of date. */
  onMerged: () => void;
}) {
  const { platform, repo, number } = props.pull;
  const query = new URLSearchParams({ platform, repo, number: String(number) }).toString();
  const { data } = useLoad(() => api<PullStackView>(`/pulls/stack?${query}`), [query]);
  const [job, setJob] = useState<StackMergeJobView | null>(null);
  const [changed, setChanged] = useState(false);
  const started = (r: StackMergeAnswer) => {
    if (r.job) setJob(r.job);
    else setChanged(true);
  };
  if (job) return <MergingStack job={job} onMerged={props.onMerged} />;
  if (changed)
    return (
      <p className="error" role="alert">
        The stack changed since this page loaded. Reload to see it.
      </p>
    );
  if (!data || data.pulls.length < 2) return null;
  const chain = chainTo(data.pulls, number);
  return (
    <section className="card card-pad stack" aria-label="Stack">
      <div className="strong">
        Stack <span className="subtle small">onto {data.trunk}</span>
      </div>
      <ol className="pull-stack-list">
        {data.pulls.map((p) => {
          return (
            <li key={p.number} style={{ paddingInlineStart: `${depthOf(data.pulls, p) * 10}px` }}>
              <Link
                to={pullPath(platform, repo, p.number)}
                className="pull-stack-link"
                current={p.number === number}
              >
                <CheckMark checks={p.checks} />
                <span className="mono subtle">#{p.number}</span>
                <span className="pull-stack-title" title={p.title}>
                  {p.title}
                </span>
                {p.draft && <span className="subtle small">draft</span>}
              </Link>
            </li>
          );
        })}
      </ol>
      {chain.length > 1 && props.mergeMethods.length > 0 && (
        <MergeStack
          pull={props.pull}
          chain={chain}
          methods={props.mergeMethods}
          onStarted={started}
        />
      )}
    </section>
  );
}

function MergeStack(props: {
  pull: Ref;
  chain: StackedPull[];
  methods: MergeMethod[];
  onStarted: (r: StackMergeAnswer) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [method, setMethod] = useState<MergeMethod>(props.methods[0] ?? "merge");
  const merge = useAction(() =>
    api<StackMergeAnswer>("/pulls/merge-stack", {
      method: "POST",
      body: JSON.stringify({
        ...props.pull,
        method,
        heads: props.chain.map((p) => ({ number: p.number, head: p.headSha })),
      }),
    }),
  );
  const confirm = async () => {
    const r = await merge.run();
    setAsking(false);
    if (r) props.onStarted(r);
  };
  const n = props.chain.length;
  return (
    <>
      {asking ? (
        <>
          <span className="small">
            Merges {n} pull requests bottom first, each retargeted to the trunk once the one below
            lands and merged when its checks pass.
          </span>
          {props.methods.length > 1 && (
            <select
              className="input"
              aria-label="Stack merge method"
              value={method}
              onChange={(e) => setMethod(e.target.value as MergeMethod)}
            >
              {props.methods.map((m) => (
                <option key={m} value={m}>
                  {stackMethodLabels(props.pull.platform)[m]}
                </option>
              ))}
            </select>
          )}
          <div className="row-gap">
            <Button className="grow" disabled={merge.busy} onClick={confirm}>
              Confirm: merge {n}
            </Button>
            <Button variant="outline" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button variant="outline" onClick={() => setAsking(true)}>
          Merge stack up to here
        </Button>
      )}
      {merge.error !== null && (
        <p className="error" role="alert">
          Could not merge the stack: {why(merge.error)}.
        </p>
      )}
    </>
  );
}

/** How far a stack merge got, read again while it runs. */
function MergingStack(props: { job: StackMergeJobView; onMerged: () => void }) {
  const [job, setJob] = useState(props.job);
  const { platform, repo, bottom, step, state } = job;
  const query = new URLSearchParams({ platform, repo, number: String(bottom) }).toString();
  const active = ACTIVE.has(state);
  const { onMerged } = props;
  useEffect(() => {
    if (step > 0) onMerged();
  }, [step, onMerged]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const r = await api<StackMergeAnswer>(`/pulls/merge-stack?${query}`).catch(() => null);
      if (r?.job) setJob(r.job);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, query]);
  const cancel = useAction(async () => {
    const r = await api<StackMergeAnswer>("/pulls/merge-stack", {
      method: "DELETE",
      body: JSON.stringify({ platform, repo, number: bottom }),
    });
    if (r.job) setJob(r.job);
  });
  // Squashed or rebased layers land as new commits, so a branch built on the old ones still carries them.
  const stale = job.method !== "merge" && job.restacked.some((s) => s.outcome === "done");
  const layerText = (i: number) => {
    if (i < step) return "Merged.";
    if (i > step) return state === "waiting" || state === "running" ? "Next." : "Not merged.";
    if (state === "cancelled") return "Cancelled.";
    return job.reason ? REASON[job.reason] : "Merging.";
  };
  return (
    <section className="card card-pad stack" aria-label="Stack">
      <div className="strong">Stack merge</div>
      <ul className="pull-stack-steps small" role="status">
        {job.chain.map((l, i) => (
          <li key={l.number} className={i === step && state === "failed" ? "error" : undefined}>
            <span className="mono">#{l.number}</span> {layerText(i)}
          </li>
        ))}
        {job.restacked.map((s) => (
          <li key={s.number} className={s.outcome === "done" ? undefined : "error"}>
            <span className="mono">#{s.number}</span>{" "}
            {s.outcome === "done" ? (
              <>
                Now onto <span className="mono">{job.trunk}</span>.
              </>
            ) : (
              <>Still on a merged branch: {STEP[s.outcome]}</>
            )}
          </li>
        ))}
      </ul>
      {active && (
        <Button variant="outline" disabled={cancel.busy} onClick={() => cancel.run()}>
          Stop the stack merge
        </Button>
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
