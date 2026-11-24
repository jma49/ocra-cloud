import Download from "lucide-react/icons/download";
import { type CSSProperties, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ReviewTraceView, TraceFindingView } from "../../../src/shared/index.js";
import { num } from "../format.js";
import { splitPath } from "../pull/diff.js";
import {
  byFate,
  callLabel,
  cost,
  fateLabel,
  funnel,
  place,
  reviewerLabel,
  rows,
  secs,
  stageLabel,
  summary,
  type TraceRow,
  ticks,
} from "./model.js";
import { RowDetail } from "./row-detail.js";

// How the review came to its findings (ADR-0081 of the engine), as evidence a
// person can check: the run on one time axis (stages, each task and its
// attempts, each model call), each row opening what it read and spent, and
// where every reported finding ended up and why. Folded until asked for.

export function TraceCard(props: { trace: ReviewTraceView; runId: string }) {
  const { trace } = props;
  const notes = [trace.redacted && "secrets redacted", trace.truncated && "shortened"].filter(
    Boolean,
  );
  return (
    <details className="card walkthrough trace">
      <summary className="walkthrough-head">
        <span className="fold" aria-hidden="true" />
        <h2 className="walkthrough-title">Trace</h2>
        <span className="walkthrough-meta subtle small">
          {[summary(trace), ...notes].join(" · ")}
        </span>
      </summary>
      <div className="trace-body">
        <Timeline trace={trace} />
        {trace.findings.length > 0 && <Findings findings={trace.findings} />}
      </div>
      <div className="trace-foot">
        <span className="subtle small">
          Paths, counts, times and reasons only: no code, prompt or answer.
        </span>
        <Button variant="outline" size="sm" onClick={() => download(trace, props.runId)}>
          <Download aria-hidden="true" />
          Download trace
        </Button>
      </div>
    </details>
  );
}

function Timeline(props: { trace: ReviewTraceView }) {
  const { trace } = props;
  const all = rows(trace);
  const tasks = all.filter((r) => r.kind === "task");
  const calls = all.filter((r) => r.kind === "call");
  const { stepMs, at } = ticks(trace.ms);
  const grid = { "--tick": `${(stepMs / Math.max(trace.ms, 1)) * 100}%` } as CSSProperties;
  return (
    <section className="trace-section" aria-label="Timeline">
      <div className="trace-row trace-axis" aria-hidden="true">
        <span />
        <div className="trace-track">
          {at.map((t) => (
            <span key={t} className="trace-tick" style={at1(t, trace.ms)}>
              {t === 0 ? "0 s" : secs(t)}
            </span>
          ))}
        </div>
        <span />
      </div>
      <div className="trace-row trace-stages">
        <span className="quiet-label">Stages</span>
        <ol className="trace-track" style={grid}>
          {trace.stages.map((s) => {
            const { x, w } = place(s.startMs, s.ms, trace.ms);
            return (
              <li
                key={`${s.stage}-${s.startMs}`}
                className="trace-stage"
                style={span(x, w)}
                title={`${stageLabel(s.stage)}: ${secs(s.ms)}`}
              >
                {w > 0.07 && <span>{stageLabel(s.stage)}</span>}
              </li>
            );
          })}
        </ol>
        <span />
      </div>
      <Group title="Review tasks" rows={tasks} trace={trace} grid={grid} />
      <Group title="Model calls" rows={calls} trace={trace} grid={grid} />
    </section>
  );
}

function Group(props: {
  title: string;
  rows: TraceRow[];
  trace: ReviewTraceView;
  grid: CSSProperties;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (props.rows.length === 0) return null;
  return (
    <div className="trace-group">
      <div className="quiet-label trace-group-title">
        {props.title} <span className="subtle">{num(props.rows.length)}</span>
      </div>
      <ul className="trace-rows">
        {props.rows.map((row) => {
          const isOpen = open === row.key;
          return (
            <li key={row.key} className={isOpen ? "trace-item open" : "trace-item"}>
              <button
                type="button"
                className="trace-row trace-line"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : row.key)}
              >
                <RowName row={row} />
                <span className="trace-track" style={props.grid}>
                  {row.kind === "task" && (
                    <span
                      className="trace-extent"
                      style={placed(row.startMs, row.ms, props.trace.ms)}
                    />
                  )}
                  {row.spans.map((s) => (
                    <span
                      key={`${s.startMs}-${s.label}`}
                      className={`trace-span tone-${s.tone}`}
                      style={placed(s.startMs, s.ms, props.trace.ms)}
                      title={s.label}
                    />
                  ))}
                </span>
                <span className="trace-end subtle small">
                  {secs(row.ms)} ·{" "}
                  {cost(row.kind === "task" ? row.task.usage.costUsd : row.call.usage.costUsd)}
                </span>
              </button>
              {isOpen && <RowDetail row={row} findings={props.trace.findings} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RowName(props: { row: TraceRow }) {
  const { row } = props;
  if (row.kind === "call") {
    return (
      <span className="trace-name">
        <span className={row.call.failed ? "trace-label failed" : "trace-label"}>
          {callLabel(row.call)}
        </span>
      </span>
    );
  }
  const { dir, name } = splitPath(row.task.bundle);
  return (
    <span className="trace-name">
      <span className="trace-label">{reviewerLabel(row.task.reviewer)}</span>
      <span className="mono small trace-bundle" title={row.task.bundle}>
        <span className="subtle">{dir}</span>
        {name}
      </span>
    </span>
  );
}

function Findings(props: { findings: TraceFindingView[] }) {
  return (
    <section className="trace-section" aria-label="Findings">
      <div className="quiet-label trace-group-title">
        Findings <span className="subtle">{funnel(props.findings)}</span>
      </div>
      <ul className="trace-findings">
        {byFate(props.findings).map((f, i) => {
          const { dir, name } = splitPath(f.file);
          return (
            <li key={f.fingerprint ?? `${f.file}-${i}`} className={`trace-finding fate-${f.fate}`}>
              <span className={`sev-dot sev-${f.severity ?? "none"}`} aria-hidden="true" />
              <div className="trace-finding-text">
                <span className="trace-finding-title">{f.title}</span>
                <span className="mono small">
                  <span className="subtle">{dir}</span>
                  {name}
                  {f.line ? `:${f.line}` : ""}
                </span>
                {f.reason && <span className="muted">{f.reason}</span>}
                {f.recalibrated && (
                  <span className="muted">
                    {`The judge made it ${f.recalibrated.to}, from ${f.recalibrated.from}: ${f.recalibrated.reason}`}
                  </span>
                )}
              </div>
              <span className="trace-fate small">{fateLabel(f.fate)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const span = (x: number, w: number) =>
  ({ "--x": `${x * 100}%`, "--w": `${w * 100}%` }) as CSSProperties;
const placed = (startMs: number, ms: number, total: number) => {
  const { x, w } = place(startMs, ms, total);
  return span(x, w);
};
const at1 = (t: number, total: number) =>
  ({ "--x": `${(t / Math.max(total, 1)) * 100}%` }) as CSSProperties;

function download(trace: ReviewTraceView, runId: string) {
  const blob = new Blob([`${JSON.stringify(trace, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ocra-trace-${runId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
