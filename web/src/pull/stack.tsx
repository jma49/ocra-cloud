import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodePlatformKind,
  chainTo,
  type MergeMethod,
  type PullStackView,
  type StackedPull,
  type StackMergeView,
  type StackStepOutcome,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Link } from "../router.js";
import { useAction, useLoad } from "../ui.js";
import { CHECKS } from "./check-state.js";
import { stackMethodLabels } from "./merge-method.js";
import { OUTCOME } from "./outcome.js";
import { pullPath } from "./path.js";

// The pull request's stack, read from the platform's branches (ADR-0052):
// each one links to its page, and the stack merges from the bottom up to
// this one, each with the head this page read.

type Ref = { platform: CodePlatformKind; repo: string; number: number };

const STEP: Record<StackStepOutcome, string> = {
  ...OUTCOME,
  unreached: "The platform did not answer.",
};

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
  const [result, setResult] = useState<(StackMergeView & { method: MergeMethod }) | null>(null);
  const merged = (r: StackMergeView, method: MergeMethod) => {
    setResult({ ...r, method });
    if (r.steps.some((s) => s.outcome === "done")) props.onMerged();
  };
  if (result)
    return <MergedStack trunk={data?.trunk ?? ""} result={result} method={result.method} />;
  if (!data || data.pulls.length < 2) return null;
  const chain = chainTo(data.pulls, number);
  return (
    <section className="card card-pad stack" aria-label="Stack">
      <div className="strong">
        Stack <span className="subtle small">onto {data.trunk}</span>
      </div>
      <ol className="pull-stack-list">
        {data.pulls.map((p) => {
          const checks = p.checks && CHECKS[p.checks];
          return (
            <li key={p.number} style={{ paddingInlineStart: `${depthOf(data.pulls, p) * 10}px` }}>
              <Link
                to={pullPath(platform, repo, p.number)}
                className="pull-stack-link"
                current={p.number === number}
              >
                {checks ? (
                  <span className={`chk ${checks.cls}`} role="img" aria-label={checks.label} />
                ) : (
                  <span className="chk" aria-hidden="true" />
                )}
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
          onMerged={merged}
        />
      )}
    </section>
  );
}

function MergeStack(props: {
  pull: Ref;
  chain: StackedPull[];
  methods: MergeMethod[];
  onMerged: (r: StackMergeView, method: MergeMethod) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [method, setMethod] = useState<MergeMethod>(props.methods[0] ?? "merge");
  const merge = useAction(() =>
    api<StackMergeView>("/pulls/merge-stack", {
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
    if (r) props.onMerged(r, method);
  };
  const n = props.chain.length;
  return (
    <>
      {asking ? (
        <>
          <span className="small">
            Merges {n} pull requests bottom first, each retargeted to the trunk.
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

/** What a stack merge did: each pull request it tried, then the ones above moved onto the trunk. */
function MergedStack(props: { trunk: string; result: StackMergeView; method: MergeMethod }) {
  const { steps, restacked } = props.result;
  // Squashed or rebased layers land as new commits, so a branch built on the old ones still carries them.
  const stale = props.method !== "merge" && restacked.some((s) => s.outcome === "done");
  return (
    <section className="card card-pad stack" aria-label="Stack">
      <div className="strong">Stack merge</div>
      <ul className="pull-stack-steps small" role="status">
        {steps.map((s) => (
          <li key={s.number} className={s.outcome === "done" ? undefined : "error"}>
            <span className="mono">#{s.number}</span>{" "}
            {s.outcome === "done" ? "Merged." : STEP[s.outcome]}
          </li>
        ))}
        {restacked.map((s) => (
          <li key={s.number} className={s.outcome === "done" ? undefined : "error"}>
            <span className="mono">#{s.number}</span>{" "}
            {s.outcome === "done" ? (
              <>
                Now onto <span className="mono">{props.trunk}</span>.
              </>
            ) : (
              <>Still on a merged branch: {STEP[s.outcome]}</>
            )}
          </li>
        ))}
      </ul>
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
