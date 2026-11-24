import { MAX_TRACE_TEXT, redactField, type SharedTrace } from "@open-cr-agent/cloud-contract";
import type { ReviewTraceView } from "./shared/index.js";

// A review's trace as the CLI shares it with its findings, redacted again on
// the server, as findings and walkthroughs are: a client that skipped its
// own pass gets no more stored. Its shape is already bounded by the contract.

export function parseTrace(t: SharedTrace | undefined): ReviewTraceView | undefined {
  if (!t) return undefined;
  let redacted = t.redacted === true;
  let truncated = t.truncated === true;
  const text = (v: string, max = MAX_TRACE_TEXT) => {
    const r = redactField(v, max);
    redacted ||= r.redacted;
    truncated ||= r.truncated;
    return r.text;
  };
  const path = (p: string) => text(p, 1024);
  const { redacted: _r, truncated: _t, ...rest } = t;
  const trace: ReviewTraceView = {
    ...rest,
    tasks: t.tasks.map((task) => ({
      ...task,
      bundle: text(task.bundle),
      files: task.files.map(path),
      attempts: task.attempts.map((a) => ({ ...a, read: a.read.map(path) })),
    })),
    findings: t.findings.map((f) => ({
      ...f,
      file: path(f.file),
      title: text(f.title),
      ...(f.reason === undefined ? {} : { reason: text(f.reason) }),
      ...(f.recalibrated
        ? { recalibrated: { ...f.recalibrated, reason: text(f.recalibrated.reason) } }
        : {}),
    })),
  };
  if (redacted) trace.redacted = true;
  if (truncated) trace.truncated = true;
  return trace;
}
