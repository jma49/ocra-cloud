import type { LiveFinding, Stage } from "@open-cr-agent/cloud-contract";
import type { LiveEventView } from "../../../src/shared/index.js";

// What a run's events add up to, folded in seq order: the stage it is in,
// its tasks and files, its findings (a finding sent again replaces the
// earlier one) and how it ended. Pure, so the page can fold as events arrive.

type LiveTask = {
  reviewer: string;
  files: number;
  status: "running" | "completed" | "failed" | "timed_out" | "cancelled";
};

export type LiveProgress = {
  seq: number;
  target: string;
  stage: Stage | null;
  stages: Stage[];
  tasks: Map<string, LiveTask>;
  files: { reviewed: number; total: number };
  findings: Map<string, LiveFinding>;
  warnings: string[];
  costUsd: number;
  ending:
    | { kind: "finished"; verdict: string; complete: boolean }
    | { kind: "failed"; reason: string }
    | null;
};

export const emptyProgress = (): LiveProgress => ({
  seq: 0,
  target: "",
  stage: null,
  stages: [],
  tasks: new Map(),
  files: { reviewed: 0, total: 0 },
  findings: new Map(),
  warnings: [],
  costUsd: 0,
  ending: null,
});

/** The progress after events; ones it already has (by seq) change nothing. */
export function fold(progress: LiveProgress, events: readonly LiveEventView[]): LiveProgress {
  const fresh = events.filter((e) => e.seq > progress.seq).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return progress;
  const next: LiveProgress = {
    ...progress,
    stages: [...progress.stages],
    tasks: new Map(progress.tasks),
    files: { ...progress.files },
    findings: new Map(progress.findings),
    warnings: [...progress.warnings],
  };
  for (const e of fresh) {
    next.seq = e.seq;
    switch (e.kind) {
      case "started":
        next.target = e.data.target;
        break;
      case "stage":
        next.stage = e.data.stage;
        if (!next.stages.includes(e.data.stage)) next.stages.push(e.data.stage);
        if (e.data.files) next.files.total = e.data.files.length;
        break;
      case "task.started":
        next.tasks.set(e.data.taskId, {
          reviewer: e.data.reviewer,
          files: e.data.files.length,
          status: "running",
        });
        break;
      case "task.finished": {
        const task = next.tasks.get(e.data.taskId);
        if (task) next.tasks.set(e.data.taskId, { ...task, status: e.data.status });
        break;
      }
      case "file.finished":
        if (e.data.status === "reviewed" || e.data.status === "unchanged") next.files.reviewed += 1;
        break;
      case "finding":
        if (e.data.dropped) next.findings.delete(e.data.id);
        else next.findings.set(e.data.id, e.data);
        break;
      case "warning":
        next.warnings.push(e.data.message);
        break;
      case "usage":
        next.costUsd = Math.max(next.costUsd, e.data.costUsd);
        break;
      case "finished":
        next.costUsd = Math.max(next.costUsd, e.data.usage.costUsd);
        next.ending = { kind: "finished", verdict: e.data.verdict, complete: e.data.complete };
        break;
      case "failed":
        next.ending = { kind: "failed", reason: e.data.reason };
        break;
    }
  }
  return next;
}
