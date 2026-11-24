import Check from "lucide-react/icons/check";
import X from "lucide-react/icons/x";
import { count } from "../format.js";
import type { LiveProgress, LiveTask } from "./fold.js";

const STATUS: Record<LiveTask["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

/** A row per reviewer task under a head that counts them; the list scrolls once a large change opens many. */
export function LiveTasks(props: { progress: LiveProgress; ended: boolean }) {
  const { tasks, files } = props.progress;
  if (tasks.size === 0) return null;
  // A run that stopped never finishes the tasks it had open.
  const rows = [...tasks].map(
    ([id, task]) =>
      [id, task, task.status === "running" && props.ended ? "cancelled" : task.status] as const,
  );
  const done = rows.filter(([, , status]) => status !== "running").length;
  return (
    <section className="live-group" aria-label="Reviewers">
      <h2 className="live-group-head">
        Reviewers
        <span className="subtle">
          {done} of {rows.length}
          {files.total > 0 && ` · ${files.reviewed} of ${count(files.total, "file")}`}
        </span>
      </h2>
      <ul className="live-steps live-tasks" aria-label="Tasks">
        {rows.map(([id, task, status]) => {
          const quiet = status === "running" || status === "completed";
          return (
            <li key={id} className={`live-step is-${status}`}>
              <StepMark status={status} />
              <span className="live-step-name">{task.reviewer}</span>
              <span className="subtle small">
                {quiet ? count(task.files, "file") : STATUS[status]}
              </span>
              {quiet && <span className="sr-only">{STATUS[status]}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A task's standing as a 16 px mark: a turning ring while it runs, a check once done, a cross when it failed. */
function StepMark(props: { status: LiveTask["status"] }) {
  const { status } = props;
  if (status === "running") {
    return (
      <svg className="task-mark is-running" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="task-ring-track" cx="8" cy="8" r="6" />
        <circle className="task-ring-arc" cx="8" cy="8" r="6" pathLength="100" />
      </svg>
    );
  }
  const Icon = status === "completed" ? Check : X;
  return (
    <span className={`task-mark is-${status === "completed" ? "done" : "failed"}`}>
      <Icon size={12} aria-hidden="true" />
    </span>
  );
}
