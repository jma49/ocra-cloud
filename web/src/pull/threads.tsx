import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  PullActionOutcome,
  PullThreadsView,
  ReviewThreadView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useRead } from "../cache.js";
import { useToast } from "../toast.js";
import { useAction } from "../ui.js";
import { OUTCOME } from "./outcome.js";
import { ThreadItem } from "./thread-item.js";

// The pull request's review threads: their comments as Markdown, the
// suggestions in them, applied together as one commit of the head the
// threads were read at, and each thread resolved or reopened. Resolving
// and replying show at once and are taken back if the platform refuses.

type Pull = { platform: string; repo: string; number: number };
type Answer = { outcome: PullActionOutcome };

const post = (path: string, body: unknown) =>
  api<Answer>(`/pulls/${path}`, { method: "POST", body: JSON.stringify(body) });

/**
 * What this page did ahead of the platform's answer, laid over what it read.
 * A step the platform took stays until a read newer than `seen` replaces it,
 * so nothing flickers back while the page reads again.
 */
type Step = {
  thread: string;
  resolved?: boolean;
  reply?: string;
  seen?: PullThreadsView | undefined;
};

function laidOver(t: ReviewThreadView, steps: Step[]): ReviewThreadView {
  const mine = steps.filter((s) => s.thread === t.id);
  if (mine.length === 0) return t;
  const resolved = mine.reduce((r, s) => s.resolved ?? r, t.resolved);
  const sending = mine.flatMap((s, i) =>
    s.reply === undefined
      ? []
      : [
          {
            id: `sending:${t.id}:${i}`,
            author: null,
            body: s.reply,
            createdAt: null,
            suggestions: [],
          },
        ],
  );
  return { ...t, resolved, comments: [...t.comments, ...sending] };
}

export function ThreadsPanel(props: { pull: Pull; onDone: (o: PullActionOutcome) => void }) {
  const query = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, error, reload } = useRead<PullThreadsView>(`/pulls/threads?${query}`);
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [sendError, setSendError] = useState<unknown>(null);
  const commit = useAction(post);
  const shown = useRef(data);
  shown.current = data;
  // Steps the platform took are in every read after the one they were taken at.
  useEffect(() => {
    setSteps((all) => all.filter((s) => s.seen === undefined || s.seen === data));
  }, [data]);

  const send = async (path: string, body: object): Promise<PullActionOutcome | null> => {
    setSendError(null);
    try {
      return (await post(path, body)).outcome;
    } catch (e) {
      setSendError(e);
      return null;
    }
  };
  const take = async (step: Step, path: string, body: object) => {
    setSteps((all) => [...all, step]);
    const outcome = await send(path, { ...props.pull, thread: step.thread, ...body });
    if (outcome !== "done") {
      setSteps((all) => all.filter((s) => s !== step));
      if (outcome) toast(OUTCOME[outcome], "error");
      return false;
    }
    setSteps((all) => all.map((s) => (s === step ? { ...s, seen: shown.current } : s)));
    reload();
    return true;
  };

  const resolve = async (thread: string, to: boolean) => {
    if (await take({ thread, resolved: to }, "resolve-thread", { resolved: to })) {
      toast(to ? "Thread resolved" : "Thread reopened", "success", {
        label: "Undo",
        run: () => void resolve(thread, !to),
      });
    }
  };

  const reply = (thread: string, body: string) =>
    take({ thread, reply: body }, "reply-thread", { body });

  if (error && !data) {
    return <p className="error small">Could not read the review threads: {why(error)}.</p>;
  }
  if (!data || data.threads.length === 0) return null;
  const live = steps.filter((s) => s.seen === undefined || s.seen === data);
  const threads = data.threads.map((t) => laidOver(t, live));
  const toggle = (id: string) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
  const fileOf = (id: string) =>
    threads.find((t) => t.comments.some((c) => c.suggestions.some((s) => s.id === id)))?.path;
  // GitHub commits suggestions together only within one file.
  const only = props.pull.platform === "github" && picked[0] ? fileOf(picked[0]) : undefined;
  const open = threads.filter((t) => !t.resolved).length;
  const resolved = threads.length - open;
  const offers = threads.some(
    (t) => !t.resolved && t.comments.some((c) => c.suggestions.some((s) => s.applicable)),
  );
  const failed = sendError ?? commit.error;
  return (
    <section className="stack" aria-label="Review threads">
      <div className="row-gap checks-head">
        <h2 className="card-title grow">Review threads</h2>
        <span className="subtle small">
          {[open > 0 ? `${open} open` : "", resolved > 0 ? `${resolved} resolved` : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <ul className="thread-list">
        {threads.map((t) => (
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
            reply={(body) => reply(t.id, body)}
            resolve={() => void resolve(t.id, !t.resolved)}
          />
        ))}
      </ul>
      {data.truncated && (
        <span className="subtle small">More threads are on the platform than one page reads.</span>
      )}
      {offers && (
        <div className="row-gap thread-commit">
          <Button
            loading={commit.busy}
            disabled={picked.length === 0 || commit.busy}
            onClick={async () => {
              const r = await commit.run("apply-suggestions", {
                ...props.pull,
                head: data.head,
                suggestions: picked,
              });
              if (!r) return;
              props.onDone(r.outcome);
              if (r.outcome === "done") {
                setPicked([]);
                reload();
              }
            }}
          >
            {picked.length === 1
              ? "Commit suggestion"
              : `Commit ${picked.length > 0 ? `${picked.length} ` : ""}suggestions`}
          </Button>
          <span className="subtle small">
            One commit on the pull request's branch, made as you.
            {props.pull.platform === "github" && " On GitHub, one file per commit."}
          </span>
        </div>
      )}
      {failed !== null && (
        <p className="error" role="alert">
          Could not send it: {why(failed)}.
        </p>
      )}
    </section>
  );
}
