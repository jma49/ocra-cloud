import type {
  TraceAttemptView,
  TraceCallView,
  TraceFindingView,
  TraceTaskView,
} from "../../../src/shared/index.js";
import { count, num } from "../format.js";
import { splitPath } from "../pull/diff.js";
import {
  cost,
  endingLabel,
  fateLabel,
  modelLabel,
  secs,
  stageLabel,
  type TraceRow,
} from "./model.js";

// What one row of the trace opens: a task's attempts (the model, what it
// read, the tools it called, what it spent) and the findings it reported, or
// a model call's model and spend.

export function RowDetail(props: { row: TraceRow; findings: TraceFindingView[] }) {
  const { row } = props;
  return (
    <div className="trace-detail">
      {row.kind === "task" ? (
        <TaskDetail
          task={row.task}
          findings={props.findings.filter((f) => f.taskId === row.task.id)}
        />
      ) : (
        <CallDetail call={row.call} />
      )}
    </div>
  );
}

function TaskDetail(props: { task: TraceTaskView; findings: TraceFindingView[] }) {
  const { task } = props;
  return (
    <>
      <dl className="trace-props">
        <dt>Files</dt>
        <dd>{count(task.files.length, "file")}</dd>
        <dt>Outcome</dt>
        <dd>{STATUS[task.status]}</dd>
        <dt>Tokens</dt>
        <dd>{tokens(task.usage)}</dd>
      </dl>
      {task.attempts.length === 0 && (
        <p className="subtle small">
          {task.reused ? "Taken from an earlier run of this review." : "No attempt was recorded."}
        </p>
      )}
      <ol className="trace-attempts">
        {task.attempts.map((a, i) => (
          <Attempt key={`${a.startMs}-${a.model}`} a={a} n={i + 1} of={task.attempts.length} />
        ))}
      </ol>
      {props.findings.length > 0 && (
        <div className="trace-reported">
          <span className="quiet-label">Reported</span>
          <ul>
            {props.findings.map((f, i) => (
              <li key={f.fingerprint ?? i}>
                <span>{f.title}</span>
                <span className="subtle small">{fateLabel(f.fate)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

const STATUS: Record<TraceTaskView["status"], string> = {
  completed: "Completed",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

function Attempt(props: { a: TraceAttemptView; n: number; of: number }) {
  const { a } = props;
  const tools = Object.entries(a.tools).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return (
    <li className="trace-attempt">
      <div className="trace-attempt-head">
        <span
          className={`trace-mark tone-${a.ending === "done" ? "ok" : a.ending === "error" ? "failed" : "partial"}`}
          aria-hidden="true"
        />
        <span className="trace-label">
          {props.of > 1 ? `Attempt ${props.n} · ` : ""}
          {modelLabel(a.model)}
        </span>
        <span className="subtle small">
          {[endingLabel(a.ending), count(a.steps, "step"), secs(a.ms), cost(a.usage.costUsd)].join(
            " · ",
          )}
        </span>
      </div>
      {tools.length > 0 && (
        <ul className="trace-tools" aria-label="Tool calls">
          {tools.map(([name, n]) => (
            <li key={name}>
              <span className="mono small">{name}</span>{" "}
              <span className="subtle small">{num(n)}</span>
            </li>
          ))}
          {a.searches > 0 && (
            <li className="subtle small">
              {count(a.searches, "search", "searches")}, literals not kept
            </li>
          )}
        </ul>
      )}
      {a.read.length > 0 && <ReadFiles paths={a.read} />}
    </li>
  );
}

// Past a handful, what an attempt read folds, so a long task does not push the rest away.
function ReadFiles(props: { paths: string[] }) {
  const list = (
    <ul className="trace-read">
      {props.paths.map((p) => {
        const { dir, name } = splitPath(p);
        return (
          <li key={p} className="mono small" title={p}>
            <span className="subtle">{dir}</span>
            {name}
          </li>
        );
      })}
    </ul>
  );
  if (props.paths.length <= 5) {
    return (
      <div className="trace-read-open">
        <span className="quiet-label">Read</span>
        {list}
      </div>
    );
  }
  return (
    <details className="trace-read-fold">
      <summary>
        <span className="fold" aria-hidden="true" />
        <span className="quiet-label">Read</span>{" "}
        <span className="subtle small">{count(props.paths.length, "file")}</span>
      </summary>
      {list}
    </details>
  );
}

function CallDetail(props: { call: TraceCallView }) {
  const { call } = props;
  return (
    <dl className="trace-props">
      <dt>Model</dt>
      <dd title={call.model}>{modelLabel(call.model)}</dd>
      {call.stage && (
        <>
          <dt>Stage</dt>
          <dd>{stageLabel(call.stage)}</dd>
        </>
      )}
      <dt>Outcome</dt>
      <dd>{call.failed ? "Failed" : "Answered"}</dd>
      <dt>Tokens</dt>
      <dd>{tokens(call.usage)}</dd>
    </dl>
  );
}

function tokens(u: TraceTaskView["usage"]): string {
  const cached = u.cachedTokens > 0 ? ` (${num(u.cachedTokens)} cached)` : "";
  return `${num(u.inputTokens)} in${cached} · ${num(u.outputTokens)} out`;
}
