import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  MergeQueueView,
  PullActionOutcome,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { CloseGlyph } from "../glyphs.js";
import { Link } from "../router.js";
import { useAction, usePoll } from "../ui.js";
import { pullPath } from "./path.js";
import { QUEUE_STATE, queuePlace, queueRemoval, queueSize } from "./queue-words.js";

// The base branch's own merge queue in place of a direct merge: the queue
// runs the checks on the pull request as it would land, then merges it.
// While the pull request is queued the card reads its place again, and tells
// the page when it has left, merged or dropped.

const POLL_MS = 10_000;

type Pull = { platform: CodePlatformKind; repo: string; number: number };

export function QueueBox(props: {
  view: MergeQueueView;
  pull: Pull;
  head: string;
  /** Whether queueing is the pull request's next step. */
  primary: boolean;
  onDone: (o: PullActionOutcome) => void;
  reload: () => void;
  /** It left the queue without this card's doing: what the page shows is out of date. */
  onLeft: () => void;
}) {
  const { view, pull, reload, onLeft } = props;
  const { entry, removed } = view;
  const write = useAction((path: "enqueue" | "dequeue", body: unknown) =>
    api<{ outcome: PullActionOutcome }>(`/pulls/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  const queued = entry !== null;
  usePoll(queued, reload, POLL_MS);
  const was = useRef(queued);
  const leaving = useRef(false);
  useEffect(() => {
    if (was.current && !queued && !leaving.current) onLeft();
    was.current = queued;
    leaving.current = false;
  }, [queued, onLeft]);
  const send = async (path: "enqueue" | "dequeue") => {
    const r = await write.run(path, path === "enqueue" ? { ...pull, head: props.head } : pull);
    if (!r) return;
    props.onDone(r.outcome);
    if (r.outcome !== "done") return;
    leaving.current = path === "dequeue";
    reload();
  };
  const state = entry && QUEUE_STATE[entry.state];
  return (
    <section className="card card-pad stack" aria-label="Merge queue">
      <div className="row-gap checks-head">
        <h2 className="card-title grow">Merge queue</h2>
        {state && <span className={state.tone}>{state.label}</span>}
      </div>
      {entry && state ? (
        <>
          <span className="small">{state.says}</span>
          {queuePlace(entry, view.size).length > 0 && (
            <span className="subtle small">{queuePlace(entry, view.size).join(" · ")}</span>
          )}
          {view.ahead.length > 0 && (
            <div className="stack queue-ahead">
              <span className="subtle small">Ahead of it</span>
              <ol>
                {view.ahead.map((a) => (
                  <li key={a.number}>
                    <Link to={pullPath(pull.platform, pull.repo, a.number)} className="queue-pull">
                      <span className="mono subtle">#{a.number}</span>
                      <span className="pull-stack-title" title={a.title}>
                        {a.title}
                      </span>
                    </Link>
                    <span className="subtle small">{QUEUE_STATE[a.state].label}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <Button variant="outline" loading={write.busy} onClick={() => send("dequeue")}>
            Remove from queue
          </Button>
        </>
      ) : (
        <>
          {removed && (
            <p className="small queue-removed" role="status">
              <span className="check-mark err" aria-hidden="true">
                <CloseGlyph size={14} />
              </span>
              <span>{queueRemoval(removed)}</span>
            </p>
          )}
          <span className="subtle small">
            This branch merges through a queue: it runs the checks on each pull request as it would
            land, then merges it.
            {view.size !== null && ` ${queueSize(view.size)}`}
          </span>
          <Button
            variant={props.primary ? "default" : "outline"}
            loading={write.busy}
            onClick={() => send("enqueue")}
          >
            {removed ? "Add to merge queue again" : "Add to merge queue"}
          </Button>
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
