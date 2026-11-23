import { Button } from "@/components/ui/button";
import type { GenerateJobView, GenerateKind } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { givenUp } from "../auto-review/job-error.js";
import { useRead } from "../cache.js";
import { useAction, usePoll } from "../ui.js";

// Tests or docstrings for the head the page read, written by the server's
// runner and committed to the pull request's branch as the ocra bot. Shown
// only for a repository this account enrolled for reviews on this server.

const KIND: Record<GenerateKind, { ask: string; noun: string }> = {
  tests: { ask: "Generate unit tests", noun: "Tests" },
  docstrings: { ask: "Generate docstrings", noun: "Docstrings" },
};
const KINDS = Object.keys(KIND) as GenerateKind[];

const STATE: Record<GenerateJobView["state"], string> = {
  queued: "queued",
  running: "being written",
  done: "committed to the branch, or nothing needed adding",
  failed: "could not be written",
  superseded: "replaced by a newer request",
};

/** How often the card looks again while a request is waiting or running. */
const POLL_MS = 10_000;

type Pull = { platform: string; repo: string; number: number };
type Listing = { enrolled: boolean; jobs: GenerateJobView[] };

export function GenerateBox(props: { pull: Pull; head: string }) {
  const query = new URLSearchParams({
    platform: props.pull.platform,
    repo: props.pull.repo,
    number: String(props.pull.number),
  });
  const { data, reload } = useRead<Listing>(`/auto-review/generate?${query}`);
  const ask = useAction((kind: GenerateKind) =>
    api<{ queued: boolean }>("/auto-review/generate", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, head: props.head, kind }),
    }),
  );
  const ofHead = (kind: GenerateKind) =>
    data?.jobs.find((j) => j.kind === kind && j.head === props.head);
  const active = KINDS.some((k) => {
    const state = ofHead(k)?.state;
    return state === "queued" || state === "running";
  });
  usePoll(active, reload, POLL_MS);
  if (!data?.enrolled) return null;
  const send = async (kind: GenerateKind) => {
    if (await ask.run(kind)) reload();
  };
  return (
    <section className="card card-pad stack" aria-label="Write with ocra">
      <h2 className="card-title">Write with ocra</h2>
      <span className="subtle small">
        ocra commits what it writes to this branch. It does not run the tests: read them before you
        merge.
      </span>
      {KINDS.map((kind) => {
        const job = ofHead(kind);
        return (
          <div key={kind} className="stack">
            <Button
              type="button"
              variant="outline"
              disabled={ask.busy || job !== undefined}
              onClick={() => send(kind)}
            >
              {KIND[kind].ask}
            </Button>
            {job && (
              <span
                className={job.state === "failed" ? "error small" : "subtle small"}
                role="status"
              >
                {KIND[kind].noun} for this head: {STATE[job.state]}
                {job.error === "not_committed"
                  ? " (the branch moved, or ocra cannot push to it)"
                  : givenUp(job.error) && ` (${givenUp(job.error)?.toLowerCase()})`}
                .
              </span>
            )}
          </div>
        );
      })}
      {ask.error !== null && (
        <p className="error" role="alert">
          Could not ask for it: {why(ask.error)}.
        </p>
      )}
    </section>
  );
}
