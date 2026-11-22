import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PullActionOutcome, PullThreadsView } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useAction, useLoad } from "../ui.js";
import { ThreadItem } from "./thread-item.js";

// The pull request's review threads: their comments as plain text, the
// suggestions in them, applied together as one commit of the head the
// threads were read at, and each thread resolved or reopened.

type Pull = { platform: string; repo: string; number: number };
type Answer = { outcome: PullActionOutcome };

const post = (path: string, body: unknown) =>
  api<Answer>(`/pulls/${path}`, { method: "POST", body: JSON.stringify(body) });

export function ThreadsPanel(props: { pull: Pull; onDone: (o: PullActionOutcome) => void }) {
  const query = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, error, reload } = useLoad(
    () => api<PullThreadsView>(`/pulls/threads?${query}`),
    [query.toString()],
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const write = useAction(post);
  const after = (r: Answer | undefined) => {
    setResolving(null);
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
  const fileOf = (id: string) =>
    data.threads.find((t) => t.comments.some((c) => c.suggestions.some((s) => s.id === id)))?.path;
  // GitHub commits suggestions together only within one file.
  const only = props.pull.platform === "github" && picked[0] ? fileOf(picked[0]) : undefined;
  const open = data.threads.filter((t) => !t.resolved).length;
  const resolved = data.threads.length - open;
  const offers = data.threads.some(
    (t) => !t.resolved && t.comments.some((c) => c.suggestions.some((s) => s.applicable)),
  );
  return (
    <section className="card card-pad stack" aria-label="Review threads">
      <div className="row-gap checks-head">
        <span className="strong grow">Review threads</span>
        <span className="subtle small">
          {[open > 0 ? `${open} open` : "", resolved > 0 ? `${resolved} resolved` : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <ul className="thread-list">
        {data.threads.map((t) => (
          <ThreadItem
            key={t.id}
            t={t}
            picked={picked}
            blocked={
              only !== undefined && t.path !== only
                ? "On GitHub, suggestions committed together must be in one file."
                : null
            }
            toggle={toggle}
            resolving={resolving === t.id}
            busy={write.busy}
            reply={async (body) => {
              // Not this thread's id: only the reply's own button shows it is being sent.
              setResolving(`reply:${t.id}`);
              const r = await write.run("reply-thread", { ...props.pull, thread: t.id, body });
              after(r);
              return r?.outcome === "done";
            }}
            resolve={async () => {
              setResolving(t.id);
              after(
                await write.run("resolve-thread", {
                  ...props.pull,
                  thread: t.id,
                  resolved: !t.resolved,
                }),
              );
            }}
          />
        ))}
      </ul>
      {data.truncated && (
        <span className="subtle small">More threads are on the platform than one page reads.</span>
      )}
      {offers && (
        <>
          <Button
            loading={write.busy && resolving === null}
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
            {picked.length === 1
              ? "Commit suggestion"
              : `Commit ${picked.length > 0 ? `${picked.length} ` : ""}suggestions`}
          </Button>
          <span className="subtle small">
            One commit on the pull request's branch, made as you.
            {props.pull.platform === "github" && " On GitHub, one file per commit."}
          </span>
        </>
      )}
      {write.error !== null && (
        <p className="error" role="alert">
          Could not send it: {why(write.error)}.
        </p>
      )}
    </section>
  );
}
