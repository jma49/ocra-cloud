import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CodePlatformKind,
  chainTo,
  type MergeMethod,
  type PullStackView,
  type StackedPull,
  type StackMergeAnswer,
  type StackMergeJobView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useRead } from "../cache.js";
import { Link } from "../router.js";
import { useAction, useLoad } from "../ui.js";
import { CheckMark } from "./check-mark.js";
import { stackMethodLabels } from "./merge-method.js";
import { pullPath } from "./path.js";
import { StackMergeJob, stackMergeActive } from "./stack-merge.js";

// The pull request's stack, read from the platform's branches (ADR-0052):
// each one links to its page, and the stack merges from the bottom up to
// this one, each with the head this page read, as a merge the server runs
// layer by layer while this page reads how far it got.

type Ref = { platform: CodePlatformKind; repo: string; number: number };

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
  const { data } = useRead<PullStackView>(`/pulls/stack?${query}`);
  const [job, setJob] = useState<StackMergeJobView | null>(null);
  const [changed, setChanged] = useState(false);
  // A merge under way outlives the page that started it: one named by this stack's bottom shows again.
  const bottom = data ? (chainTo(data.pulls, number)[0]?.number ?? number) : null;
  const under = useLoad(
    () =>
      bottom === null
        ? Promise.resolve(undefined)
        : api<StackMergeAnswer>(
            `/pulls/merge-stack?${new URLSearchParams({ platform, repo, number: String(bottom) })}`,
          ),
    [platform, repo, bottom],
  ).data?.job;
  const started = (r: StackMergeAnswer) => {
    if (r.job) setJob(r.job);
    else setChanged(true);
  };
  const shown = job ?? (under && stackMergeActive(under) ? under : null);
  if (shown) {
    const titles = new Map(data?.pulls.map((p) => [p.number, p.title]));
    return <StackMergeJob key={shown.id} job={shown} titles={titles} onMerged={props.onMerged} />;
  }
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
