import type { Stage } from "@open-cr-agent/cloud-contract";
import { usd } from "../format.js";
import type { LiveProgress } from "./fold.js";

// Where a live run is: its stages, tasks, files and spend.

// In the engine's order; a Record so a new stage fails to compile here.
const STAGE_NAMES: Record<Stage, string> = {
  select: "Select files",
  bundle: "Bundle",
  plan: "Plan",
  review: "Review",
  filter: "Filter",
  verify: "Verify",
  judge: "Judge",
};
const STAGES = Object.keys(STAGE_NAMES) as Stage[];

export function LiveStages(props: { progress: LiveProgress; ended: boolean }) {
  const { stage, stages } = props.progress;
  return (
    <ol className="live-stages" aria-label="Stages">
      {STAGES.map((s) => {
        const state =
          stage === s && !props.ended ? "current" : stages.includes(s) ? "done" : "waiting";
        return (
          <li
            key={s}
            className={`live-stage is-${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="live-stage-dot" aria-hidden="true" />
            {STAGE_NAMES[s]}
          </li>
        );
      })}
    </ol>
  );
}

export function LiveCounts(props: { progress: LiveProgress }) {
  const { tasks, files, costUsd } = props.progress;
  const all = [...tasks.values()];
  const done = all.filter((t) => t.status !== "running").length;
  return (
    <>
      <dt>Tasks</dt>
      <dd>
        {done} of {all.length}
      </dd>
      <dt>Files</dt>
      <dd>{files.total > 0 ? `${files.reviewed} of ${files.total}` : files.reviewed}</dd>
      <dt>Spent</dt>
      <dd>{usd(costUsd)}</dd>
    </>
  );
}
