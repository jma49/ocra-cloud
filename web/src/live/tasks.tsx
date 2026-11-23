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

export function LiveTasks(props: { tasks: LiveProgress["tasks"]; ended: boolean }) {
  if (props.tasks.size === 0) return null;
  return (
    <ul className="live-tasks" aria-label="Tasks">
      {[...props.tasks].map(([id, task]) => {
        // A run that stopped never finishes the tasks it had open.
        const status = task.status === "running" && props.ended ? "cancelled" : task.status;
        const quiet = status === "running" || status === "completed";
        return (
          <li key={id} className="live-task">
            <TaskMark status={status} />
            <span className="live-task-name">{task.reviewer}</span>
            <span className="subtle small">
              {quiet ? count(task.files, "file") : STATUS[status]}
            </span>
            {quiet && <span className="sr-only">{STATUS[status]}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function TaskMark(props: { status: LiveTask["status"] }) {
  if (props.status === "running") {
    return (
      <svg className="task-mark is-running" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="task-ring-track" cx="8" cy="8" r="6" />
        <circle className="task-ring-arc" cx="8" cy="8" r="6" pathLength="100" />
      </svg>
    );
  }
  const Icon = props.status === "completed" ? Check : X;
  return (
    <span className={`task-mark is-${props.status === "completed" ? "done" : "failed"}`}>
      <Icon size={12} aria-hidden="true" />
    </span>
  );
}
