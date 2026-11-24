import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CodePlatformKind,
  PullRestackAnswer,
  PullRestackView,
  RestackJobView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Status } from "../components/status.js";
import { useAction, useLoad, usePoll } from "../ui.js";

// A layer behind the one it is stacked on, restacked from its page: ocra
// rebases it onto that one's head and force-pushes it, where the repository
// turned restacks on. The page reads how the job stands while it runs.

const ACTIVE_MS = 4_000;

type Ref = { platform: CodePlatformKind; repo: string; number: number };

const active = (job: RestackJobView | null | undefined) =>
  job?.state === "queued" || job?.state === "running";

const NOT_QUEUED: Record<Exclude<PullRestackAnswer["outcome"], "queued" | "running">, string> = {
  stack_changed: "The stack changed since this page loaded. Reload to see it.",
  held: "A merge of this stack holds this pull request.",
};

const SKIPPED: Record<string, string> = {
  switched_off: "restacking was switched off before it ran.",
  stack_merge: "a merge of this stack holds this pull request.",
  up_to_date: "the branch already holds the one below it.",
  push_refused: "the platform refused ocra's push.",
};

/** Why a restack that ended left the branch as it was, in a sentence. */
function left(job: RestackJobView): string | null {
  if (job.state === "failed") return "The restack did not run. Try it again.";
  if (job.state !== "done" || job.outcome === "restacked") return null;
  if (job.outcome === "conflict") {
    return "ocra could not restack it: the rebase conflicts, so nothing was pushed.";
  }
  if (job.outcome === "lease_lost")
    return "The branch moved while ocra worked. Nothing was pushed.";
  return `Not restacked: ${(job.reason && SKIPPED[job.reason]) ?? "ocra gave no reason."}`;
}

/** Whether ocra restacks here, the newest restack of this head, and the request for one. */
export function useRestackHere(pull: Ref, head: string, parentHead: string, onDone: () => void) {
  const { platform, repo, number } = pull;
  const query = new URLSearchParams({ platform, repo, number: String(number) }).toString();
  const { data, reload } = useLoad(() => api<PullRestackView>(`/pulls/restack?${query}`), [query]);
  const [answer, setAnswer] = useState<PullRestackAnswer | null>(null);
  const ask = useAction(async () => {
    const r = await api<PullRestackAnswer>("/pulls/restack", {
      method: "POST",
      body: JSON.stringify({ ...pull, head, parentHead }),
    });
    setAnswer(r);
    reload();
  });
  // A restack of an older head says nothing of this one.
  const job = data?.job && data.job.from === head ? data.job : null;
  usePoll(active(job), reload, ACTIVE_MS);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && job?.state === "done" && job.outcome === "restacked") onDone();
    was.current = active(job);
  }, [job, onDone]);
  return { offered: data?.offered === true, job, answer, ask };
}

export function RestackHere(props: { at: ReturnType<typeof useRestackHere> }) {
  const { job, answer, ask } = props.at;
  if (active(job)) {
    return (
      <span role="status">
        <Status tone="run">{job?.state === "running" ? "Restacking" : "Restack queued"}</Status>
      </span>
    );
  }
  const refused =
    answer?.outcome === "stack_changed" || answer?.outcome === "held"
      ? NOT_QUEUED[answer.outcome]
      : null;
  const note =
    ask.error != null
      ? `Could not ask for a restack: ${why(ask.error)}.`
      : (refused ?? (job && left(job)));
  return (
    <div className="pull-restack-here">
      <Button size="sm" variant="outline" disabled={ask.busy} onClick={() => void ask.run()}>
        {job && left(job) ? "Restack again" : "Restack"}
      </Button>
      {note && (
        <span className={ask.error != null ? "error small" : "subtle small"} role="status">
          {note}
        </span>
      )}
    </div>
  );
}
