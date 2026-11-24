import type {
  ReviewTraceView,
  TraceAttemptView,
  TraceCallView,
  TraceFindingView,
  TraceTaskView,
} from "../../../src/shared/index.js";
import { parseModelId } from "../../../src/shared/index.js";
import { count, usd } from "../format.js";

// What the review page draws of a trace: rows on one time axis, each with
// the spans it is made of, and the words for stages, agents and fates.

type SpanTone = "ok" | "partial" | "failed" | "call";

type Span = { startMs: number; ms: number; tone: SpanTone; label: string };

export type TraceRow =
  | { kind: "task"; key: string; task: TraceTaskView; startMs: number; ms: number; spans: Span[] }
  | { kind: "call"; key: string; call: TraceCallView; startMs: number; ms: number; spans: Span[] };

type Stage = ReviewTraceView["stages"][number]["stage"];

const STAGES: Record<Stage, string> = {
  select: "Select",
  bundle: "Group",
  plan: "Plan",
  review: "Review",
  filter: "Filter",
  verify: "Verify",
  judge: "Judge",
  fix: "Fix",
};
export const stageLabel = (stage: Stage) => STAGES[stage];

const ROLES: Record<string, string> = {
  verifier: "Verify",
  judge: "Judge",
  helper: "Helper",
  writer: "Walkthrough",
  fixer: "Fix",
};

/** What a model call was for: a role's step, or a reviewer's plan call. */
export function callLabel(c: TraceCallView): string {
  return ROLES[c.agent] ?? `Plan for ${reviewerLabel(c.agent)}`;
}

/** A reviewer's id read as a name: "correctness" as "Correctness". */
export function reviewerLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The model's own name: an ocra Cloud model without its provider, any other after its provider's slash. */
export function modelLabel(id: string | undefined): string {
  if (!id) return "Model not named";
  const ocra = parseModelId(id);
  if (ocra) return ocra.model;
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

const ENDINGS: Record<TraceAttemptView["ending"], string> = {
  done: "Finished",
  step_cap: "Used every step",
  stopped_early: "Stopped early",
  error: "Failed",
};
export const endingLabel = (e: TraceAttemptView["ending"]) => ENDINGS[e];

const FATES: Record<TraceFindingView["fate"], string> = {
  kept: "Kept",
  refuted: "Refuted by Verify",
  dropped: "Dropped by the judge",
  merged: "Merged into another",
  outside_review: "Outside the review",
  filtered: "Filtered",
};
export const fateLabel = (f: TraceFindingView["fate"]) => FATES[f];
const FATE_ORDER = Object.keys(FATES) as TraceFindingView["fate"][];

/** Findings in the order the page lists them: kept first, then each way out. */
export function byFate(findings: readonly TraceFindingView[]): TraceFindingView[] {
  return [...findings].sort((a, b) => FATE_ORDER.indexOf(a.fate) - FATE_ORDER.indexOf(b.fate));
}

/** "5 reported · 2 kept · 1 refuted by Verify": how many went each way, the empty ones left out. */
export function funnel(findings: readonly TraceFindingView[]): string {
  const parts = FATE_ORDER.flatMap((fate) => {
    const n = findings.filter((f) => f.fate === fate).length;
    const words = FATES[fate];
    return n === 0 ? [] : [`${n} ${words.charAt(0).toLowerCase()}${words.slice(1)}`];
  });
  return [`${findings.length} reported`, ...parts].join(" · ");
}

/** A duration as the trace reads: "320 ms", "4.2 s", "1m 05s". */
export function secs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const s = Math.round(ms / 1_000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Dollars to the cent, every amount alike; one that rounds to nothing but cost something says so. */
export function cost(n: number): string {
  return n > 0 && n < 0.005 ? "<$0.01" : usd(n);
}

const tone = (a: TraceAttemptView): SpanTone =>
  a.ending === "done" ? "ok" : a.ending === "error" ? "failed" : "partial";

/** The trace as rows on one axis: tasks by when they started, then the model calls. */
export function rows(trace: ReviewTraceView): TraceRow[] {
  const tasks = trace.tasks
    .filter((t) => t.startMs !== undefined)
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
    .map(
      (task): TraceRow => ({
        kind: "task",
        key: `task:${task.id}`,
        task,
        startMs: task.startMs ?? 0,
        ms: task.ms ?? 0,
        spans: task.attempts.map((a) => ({
          startMs: a.startMs,
          ms: a.ms,
          tone: tone(a),
          label: `${modelLabel(a.model)}, ${secs(a.ms)}, ${endingLabel(a.ending).toLowerCase()}`,
        })),
      }),
    );
  const calls = [...trace.calls]
    .sort((a, b) => a.startMs - b.startMs)
    .map(
      (call, i): TraceRow => ({
        kind: "call",
        key: `call:${i}`,
        call,
        startMs: call.startMs,
        ms: call.ms,
        spans: [
          {
            startMs: call.startMs,
            ms: call.ms,
            tone: call.failed ? "failed" : "call",
            label: `${modelLabel(call.model)}, ${secs(call.ms)}${call.failed ? ", failed" : ""}`,
          },
        ],
      }),
    );
  return [...tasks, ...calls];
}

/** Where a span sits on the axis, as fractions of the run; a short one still shows. */
export function place(startMs: number, ms: number, totalMs: number): { x: number; w: number } {
  const total = Math.max(totalMs, 1);
  const x = Math.min(Math.max(startMs / total, 0), 1);
  return { x, w: Math.min(Math.max(ms / total, 0.004), 1 - x) };
}

const STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600];

/** Tick marks for a run this long: at most six, on round seconds. */
export function ticks(totalMs: number): { stepMs: number; at: number[] } {
  const s = Math.max(totalMs, 1) / 1_000;
  const stepMs = (STEPS_S.find((t) => s / t <= 6) ?? 7_200) * 1_000;
  const at: number[] = [];
  for (let t = 0; t <= totalMs; t += stepMs) at.push(t);
  return { stepMs, at };
}

/**
 * The card's summary: how long the run took, its tasks and calls, what they
 * cost. A reviewer's plan call is left out of the sum: its tasks' spend
 * already carries their share of it.
 */
export function summary(trace: ReviewTraceView): string {
  const total =
    trace.tasks.reduce((n, t) => n + t.usage.costUsd, 0) +
    trace.calls.filter((c) => c.agent in ROLES).reduce((n, c) => n + c.usage.costUsd, 0);
  return [
    secs(trace.ms),
    count(trace.tasks.length, "task"),
    count(trace.calls.length, "model call"),
    cost(total),
  ].join(" · ");
}
