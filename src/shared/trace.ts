import type { SharedTrace } from "@open-cr-agent/cloud-contract";

// A review's trace (ADR-0081 of the engine) as the review page draws it:
// the run in time (stages, tasks and their attempts, model calls) and where
// each reported finding ended up. Kept as the CLI shared it, redacted again.

export type ReviewTraceView = SharedTrace;
export type TraceTaskView = ReviewTraceView["tasks"][number];
export type TraceAttemptView = TraceTaskView["attempts"][number];
export type TraceCallView = ReviewTraceView["calls"][number];
export type TraceFindingView = ReviewTraceView["findings"][number];
