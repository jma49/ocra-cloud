import { useState } from "react";
import type { MergeQueueView, PullActionOutcome, QueueState } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction } from "../ui.js";

// The base branch's own merge queue in place of a direct merge: the queue
// runs the checks on the pull request as it would land, then merges it.

const STATE: Record<QueueState, string> = {
  waiting: "Waiting its turn",
  checking: "Checks running",
  ready: "Checks passed, merging next",
  merging: "Merging",
  blocked: "Removed soon: it cannot merge as queued",
};

type Pull = { platform: string; repo: string; number: number };

export function QueueBox(props: {
  view: MergeQueueView;
  pull: Pull;
  head: string;
  onDone: (o: PullActionOutcome) => void;
  reload: () => void;
}) {
  const entry = props.view.entry;
  const [asking, setAsking] = useState(false);
  const write = useAction((path: "enqueue" | "dequeue", body: unknown) =>
    api<{ outcome: PullActionOutcome }>(`/pulls/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  const send = async (path: "enqueue" | "dequeue") => {
    const r = await write.run(
      path,
      path === "enqueue" ? { ...props.pull, head: props.head } : props.pull,
    );
    setAsking(false);
    if (!r) return;
    props.onDone(r.outcome);
    if (r.outcome === "done") props.reload();
  };
  return (
    <section className="card card-pad stack" aria-label="Merge queue">
      <div className="strong">Merge queue</div>
      {entry ? (
        <>
          <span>
            {STATE[entry.state]}
            {entry.position !== null && (
              <span className="subtle"> · #{entry.position} in line</span>
            )}
          </span>
          <button
            type="button"
            className="btn"
            disabled={write.busy}
            onClick={() => send("dequeue")}
          >
            Remove from queue
          </button>
        </>
      ) : (
        <>
          <span className="subtle small">
            This branch merges through a queue that runs the checks before each merge.
          </span>
          {asking ? (
            <div className="row-gap">
              <button
                type="button"
                className="btn btn-primary grow"
                disabled={write.busy}
                onClick={() => send("enqueue")}
              >
                Confirm: add to queue
              </button>
              <button type="button" className="btn" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setAsking(true)}>
              Add to merge queue
            </button>
          )}
        </>
      )}
      {write.error !== null && (
        <p className="error" role="alert">
          Could not change the queue: {why(write.error)}.
        </p>
      )}
    </section>
  );
}
