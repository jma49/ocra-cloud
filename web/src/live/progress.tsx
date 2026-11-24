import type { Stage } from "@open-cr-agent/cloud-contract";
import { Elapsed } from "../elapsed.js";
import type { LiveProgress } from "./fold.js";

// Where a live run is: its stages, in the engine's order.

// A Record so a new stage fails to compile here.
const STAGE_NAMES: Record<Stage, string> = {
  select: "Select files",
  bundle: "Bundle",
  plan: "Plan",
  review: "Review",
  filter: "Filter",
  verify: "Verify",
  judge: "Judge",
  fix: "Fix",
};
const STAGES = Object.keys(STAGE_NAMES) as Stage[];

/** The stages as one bar of eight steps, named in their tooltips, and under it the one that runs now, or how the run went through them. */
export function LiveStages(props: { progress: LiveProgress; ended: boolean }) {
  const { stage, stageAt, stages } = props.progress;
  const states = STAGES.map((s) => {
    if (stage === s && !props.ended) return "running";
    if (stages.includes(s)) return "completed";
    return props.ended ? "skipped" : "waiting";
  });
  const ran = states.filter((s) => s === "completed").length;
  const skipped = STAGES.filter((_, i) => states[i] === "skipped").map((s) => STAGE_NAMES[s]);
  const current = !props.ended && stage ? stage : null;
  return (
    <section className="live-group" aria-label="Stages">
      <h2 className="live-group-head">
        Stages
        <span className="subtle">
          {ran} of {STAGES.length}
        </span>
      </h2>
      <ol className="stage-bar" aria-label="Stages">
        {STAGES.map((s, i) => (
          <li
            key={s}
            className={`stage-seg is-${states[i]}`}
            title={`${STAGE_NAMES[s]}: ${STATE_WORD[states[i] ?? "waiting"]}`}
            aria-current={states[i] === "running" ? "step" : undefined}
          >
            <span className="sr-only">
              {STAGE_NAMES[s]}: {STATE_WORD[states[i] ?? "waiting"]}
            </span>
          </li>
        ))}
      </ol>
      <p className="stage-now" aria-hidden="true">
        {current ? (
          <>
            <span className="shimmer-text">{STAGE_NAMES[current]}</span>
            {stageAt && <Elapsed since={Date.parse(stageAt)} />}
          </>
        ) : props.ended ? (
          <span className="subtle">
            {skipped.length === 0 ? "Every stage ran" : `${skipped.join(", ")} skipped`}
          </span>
        ) : (
          <span className="subtle">Starting</span>
        )}
      </p>
    </section>
  );
}

const STATE_WORD = {
  running: "running",
  completed: "done",
  waiting: "waiting",
  skipped: "skipped",
} as const;
