import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  PullActionOutcome,
  PullThreadsView,
  ReviewThreadView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction, useLoad } from "../ui.js";

// The pull request's review threads: their comments as plain text, the
// suggestions in them, applied together as one commit of the head the
// threads were read at, and each thread resolved or reopened.

type Pull = { platform: string; repo: string; number: number };
type Answer = { outcome: PullActionOutcome };

const post = (path: string, body: unknown) =>
  api<Answer>(`/pulls/${path}`, { method: "POST", body: JSON.stringify(body) });

const where = (t: ReviewThreadView) =>
  t.line === null
    ? `${t.path} (outdated)`
    : `${t.path}:${t.startLine === null ? "" : `${t.startLine}–`}${t.line}`;

export function ThreadsPanel(props: { pull: Pull; onDone: (o: PullActionOutcome) => void }) {
  const query = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, error, reload } = useLoad(
    () => api<PullThreadsView>(`/pulls/threads?${query}`),
    [query.toString()],
  );
  const [picked, setPicked] = useState<string[]>([]);
  const write = useAction(post);
  const after = (r: Answer | undefined) => {
    if (!r) return;
    props.onDone(r.outcome);
    if (r.outcome === "done") {
      setPicked([]);
      reload();
    }
  };
  if (error && !data) {
    return <p className="error small">Could not read the review threads: {why(error)}.</p>;
  }
  if (!data || data.threads.length === 0) return null;
  const toggle = (id: string) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
  return (
    <section className="card card-pad stack" aria-label="Review threads">
      <div className="strong">Review threads</div>
      {data.threads.map((t) => (
        <div key={t.id} className="stack">
          <div className="row-gap">
            <span className="mono small grow">{where(t)}</span>
            {t.resolved && <span className="badge">Resolved</span>}
            {t.canResolve && (
              <Button
                variant="outline"
                size="sm"
                disabled={write.busy}
                onClick={async () =>
                  after(
                    await write.run("resolve-thread", {
                      ...props.pull,
                      thread: t.id,
                      resolved: !t.resolved,
                    }),
                  )
                }
              >
                {t.resolved ? "Reopen" : "Resolve"}
              </Button>
            )}
          </div>
          {t.comments.map((c) => (
            <div key={c.id} className="small">
              <span className="strong">{c.author ?? "Someone"}</span>{" "}
              <span className="pre-wrap">{c.body}</span>
              {c.suggestions.map((s) => (
                <label key={s.id} className="row-gap">
                  <input
                    type="checkbox"
                    disabled={!s.applicable}
                    checked={picked.includes(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="subtle">
                    {s.applied
                      ? "Applied"
                      : s.applicable
                        ? `Apply to lines ${s.startLine}–${s.endLine}`
                        : "Outdated: cannot be applied"}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      ))}
      {data.truncated && (
        <span className="subtle small">More threads are on the platform than one page reads.</span>
      )}
      <Button
        disabled={picked.length === 0 || write.busy}
        onClick={async () =>
          after(
            await write.run("apply-suggestions", {
              ...props.pull,
              head: data.head,
              suggestions: picked,
            }),
          )
        }
      >
        Commit {picked.length === 1 ? "suggestion" : `${picked.length} suggestions`}
      </Button>
      {write.error !== null && (
        <p className="error" role="alert">
          Could not send it: {why(write.error)}.
        </p>
      )}
    </section>
  );
}
