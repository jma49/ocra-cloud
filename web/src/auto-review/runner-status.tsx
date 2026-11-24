import type { ReviewRunnersView } from "../../../src/shared/index.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";

// Where this server hands its reviews to remote runners: whether one is
// asking for work, since a queued review starts only when one does.

/** A runner asks every few seconds and is recorded once a minute: silent longer than this, it is down. */
const ONLINE_WITHIN_MS = 3 * 60_000;

export function RunnerStatus() {
  const { data } = useRead<ReviewRunnersView>("/auto-review/runners");
  if (!data?.remote) return null;
  if (data.runners.length === 0) {
    return (
      <p className="subtle small" role="status">
        No runner is connected. Reviews wait in the queue until one asks for work.
      </p>
    );
  }
  return (
    <ul className="runner-status" aria-label="Runners">
      {data.runners.map((r) => {
        const online = Date.now() - new Date(r.lastSeenAt).getTime() < ONLINE_WITHIN_MS;
        return (
          <li key={r.name}>
            <span className="strong">{r.name}</span>{" "}
            <span className={`badge ${online ? "badge-ok" : "badge-err"}`}>
              {online ? "Online" : "Offline"}
            </span>{" "}
            <span className="subtle small">
              Asked for work {ago(r.lastSeenAt)} · ocra {r.version}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
