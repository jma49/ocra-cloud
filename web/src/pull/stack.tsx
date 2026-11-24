import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
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
import { ago } from "../format.js";
import { CloseGlyph } from "../glyphs.js";
import { usePageCommands } from "../page-commands.js";
import { Link, navigate } from "../router.js";
import { useAction, useLoad } from "../ui.js";
import { CheckMark } from "./check-mark.js";
import { stackMethodLabels } from "./merge-method.js";
import { pullPath } from "./path.js";
import { RestackHere, useRestackHere } from "./restack-here.js";
import { StackMergeJob, stackMergeActive, stackMergeStop } from "./stack-merge.js";
import { stackBeside, stackLanes } from "./stack-order.js";

// The pull request's stack, read from the platform's branches (ADR-0052):
// each one links to its page, and the stack merges from the bottom up to
// this one, each with the head this page read, as a merge the server runs
// layer by layer while this page reads how far it got.

type Ref = { platform: CodePlatformKind; repo: string; number: number };

const REVIEW = {
  approved: "Approved",
  changes_requested: "Changes requested",
  required: "Review required",
} as const;

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

function Layer(props: { pull: Ref; p: StackedPull; lane: number; joined: boolean }) {
  const { p } = props;
  const review = p.review && REVIEW[p.review];
  return (
    <li
      className={props.joined ? "joined" : undefined}
      style={{ "--lane": props.lane } as CSSProperties}
    >
      <Link
        to={pullPath(props.pull.platform, props.pull.repo, p.number)}
        className="pull-stack-link"
        current={p.number === props.pull.number}
      >
        <CheckMark checks={p.checks} />
        <span className="mono subtle">#{p.number}</span>
        <span className="pull-stack-title" title={p.title}>
          {p.title}
        </span>
        <span className="pull-stack-notes">
          {p.behind !== null && p.behind > 0 && p.parent !== null && (
            <span className="warn" title={`Its branch lacks ${commits(p.behind)} of #${p.parent}`}>
              Needs restack
            </span>
          )}
          {p.draft && <span>Draft</span>}
          {review && <span>{review}</span>}
        </span>
      </Link>
    </li>
  );
}

export function StackPanel(props: {
  pull: Ref;
  mergeMethods: MergeMethod[];
  /** After a stack merge that landed any pull request: what the page shows is out of date. */
  onMerged: () => void;
  /** Brings this branch up to date with the one it is stacked on, where the page does not already offer it. */
  restack?: ReactNode;
}) {
  const { platform, repo, number } = props.pull;
  const query = new URLSearchParams({ platform, repo, number: String(number) }).toString();
  const { data, reload } = useRead<PullStackView>(`/pulls/stack?${query}`);
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
  const beside = useMemo(() => stackBeside(data?.pulls ?? [], number), [data, number]);
  usePageCommands(
    "This pull request",
    useMemo(() => {
      const to = (label: string, key: string, n: number | null) =>
        n === null ? [] : [{ label, key, run: () => navigate(pullPath(platform, repo, n)) }];
      return [...to("Down the stack", "d", beside.down), ...to("Up the stack", "u", beside.up)];
    }, [platform, repo, beside]),
  );
  const started = (r: StackMergeAnswer) => {
    if (r.job) setJob(r.job);
    else setChanged(true);
  };
  const shown = job ?? (under && stackMergeActive(under) ? under : null);
  if (shown) {
    const titles = new Map(data?.pulls.map((p) => [p.number, p.title]));
    return (
      <StackMergeJob
        key={shown.id}
        job={shown}
        titles={titles}
        onMerged={props.onMerged}
        onClose={() => {
          setJob(null);
          reload();
        }}
      />
    );
  }
  if (changed)
    return (
      <p className="error" role="alert">
        The stack changed since this page loaded. Reload to see it.
      </p>
    );
  if (!data || data.pulls.length < 2) return null;
  const chain = chainTo(data.pulls, number);
  const lanes = stackLanes(data.pulls);
  const self = data.pulls.find((p) => p.number === number);
  const below = self && data.pulls.find((p) => p.number === self.parent);
  const stop =
    under && data.pulls.some((p) => p.number === under.chain[under.step]?.number)
      ? stackMergeStop(under)
      : null;
  return (
    <section className="card card-pad stack pull-stack-card" aria-label="Stack">
      <div className="pull-stack-head">
        <h2 className="card-title">Stack</h2>
        <span className="subtle small">
          {data.pulls.length} pull requests onto <span className="mono">{data.trunk}</span>
        </span>
      </div>
      <ol className="pull-stack-list">
        {data.pulls.map((p, i) => (
          <Layer
            key={p.number}
            pull={props.pull}
            p={p}
            lane={lanes.get(p.number) ?? 0}
            joined={i > 0 && data.pulls[i - 1]?.number === p.parent}
          />
        ))}
      </ol>
      {self && below && self.behind !== null && self.behind > 0 && (
        <Behind
          pull={props.pull}
          self={self}
          below={below}
          behind={self.behind}
          mergeIn={props.restack}
          onRestacked={() => {
            reload();
            props.onMerged();
          }}
        />
      )}
      {stop && under && (
        <p className="small pull-stack-stop" role="status">
          <span className="check-mark err" aria-hidden="true">
            <CloseGlyph size={14} />
          </span>
          <span>
            The last merge of this stack stopped at #{stop.number} {ago(under.updatedAt)}:{" "}
            {stop.why}
          </span>
        </p>
      )}
      {chain.length > 1 && props.mergeMethods.length > 0 && (
        <MergeStack
          pull={props.pull}
          chain={chain}
          trunk={data.trunk}
          methods={props.mergeMethods}
          onStarted={started}
        />
      )}
    </section>
  );
}

/** This layer lacks commits of the one below: restacked here where ocra may, else locally or by a merge. */
function Behind(props: {
  pull: Ref;
  self: StackedPull;
  below: StackedPull;
  behind: number;
  mergeIn: ReactNode;
  onRestacked: () => void;
}) {
  const { self, below } = props;
  const at = useRestackHere(props.pull, self.headSha, below.headSha, props.onRestacked);
  const local = <span className="mono">ocra stack restack</span>;
  return (
    <div className="pull-stack-restack">
      <span className="small">
        This branch lacks {commits(props.behind)} of #{below.number}.{" "}
        {at.offered ? (
          <>
            ocra can rebase it onto #{below.number} and force-push it, or run {local} locally.
          </>
        ) : (
          <>
            Restack it with {local}
            {props.mergeIn ? ", or merge them in here." : "."}
          </>
        )}
      </span>
      {at.offered ? <RestackHere at={at} /> : props.mergeIn}
    </div>
  );
}

function MergeStack(props: {
  pull: Ref;
  chain: StackedPull[];
  trunk: string;
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
            Merges {props.chain.map((p) => `#${p.number}`).join(", then ")} into{" "}
            <span className="mono">{props.trunk}</span>. Each one waits for its checks, and the
            merge stops at the first that cannot land.
          </span>
          {props.chain
            .filter((p) => p.behind !== null && p.behind > 0 && p.parent !== null)
            .map((p) => (
              <span key={p.number} className="small warn" role="note">
                #{p.number} lacks {commits(p.behind ?? 0)} of #{p.parent}: restack it first, or its
                merge may conflict.
              </span>
            ))}
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
        <Button variant="outline" className="pull-stack-merge" onClick={() => setAsking(true)}>
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
