import type { LinkedTaskView } from "../../../src/shared/index.js";

const TRACKER = { github: "GitHub", gitlab: "GitLab", jira: "Jira", tapd: "TAPD" } as const;

// The tasks the change was written for, as the review was given them
// (ADR-0052 of the engine). Titles come only with shared findings; an entry
// that did not fit the upload is left out.
export function LinkedTasks(props: { tasks: readonly LinkedTaskView[] | null }) {
  const tasks = (props.tasks ?? []).filter((t) => t !== null);
  if (props.tasks === null) return null;
  return (
    <>
      <dt>Linked tasks</dt>
      <dd>
        {tasks.length === 0 ? (
          <span className="muted">None</span>
        ) : (
          <ul className="linked-tasks">
            {tasks.map((t) => (
              <li key={`${t.tracker}:${t.key}`}>
                <span className="mono">
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer">
                      {t.key}
                    </a>
                  ) : (
                    t.key
                  )}
                </span>{" "}
                <span className="subtle">{TRACKER[t.tracker]}</span>
                {t.state && (
                  <span className={t.state === "open" ? "badge badge-ok" : "badge"}>{t.state}</span>
                )}
                {t.title && <span className="linked-task-title">{t.title}</span>}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </>
  );
}
