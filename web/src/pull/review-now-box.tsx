import { Button } from "@/components/ui/button";
import type { PullReviewJobView, PullReviewNowView } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { ago } from "../format.js";
import { useAction, useLoad, usePoll } from "../ui.js";

// An AI review of the pull request's current head by the server's runner,
// asked for here. The server answers only for a repository this account
// enrolled for reviews, so the card shows for no other.

const STATE: Record<PullReviewJobView["state"], string> = {
  queued: "A review of this head is queued",
  running: "ocra is reviewing this head",
  done: "ocra reviewed this head",
  failed: "The review of this head failed",
};

/** How often the card looks again while a review is waiting or running. */
const POLL_MS = 10_000;

type Pull = { platform: string; repo: string; number: number };

export function ReviewNowBox(props: { pull: Pull; head: string }) {
  const query = new URLSearchParams({
    platform: props.pull.platform,
    repo: props.pull.repo,
    number: String(props.pull.number),
  }).toString();
  const { data, reload } = useLoad(
    () => api<PullReviewNowView>(`/pulls/review-now?${query}`),
    [query],
  );
  const ask = useAction((force: boolean) =>
    api<PullReviewNowView>("/pulls/review-now", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, force }),
    }),
  );
  const job = data?.job ?? null;
  const active = job?.state === "queued" || job?.state === "running";
  usePoll(active, reload, POLL_MS);
  if (!data) return null;
  const ofHead = job?.head === props.head ? job : null;
  const reviewed = ofHead?.state === "done";
  const send = async () => {
    if (await ask.run(reviewed)) reload();
  };
  return (
    <section className="card card-pad stack" aria-label="AI review">
      <div className="strong">AI review</div>
      <span className={ofHead?.state === "failed" ? "error small" : "subtle small"} role="status">
        {ofHead
          ? `${STATE[ofHead.state]}, asked ${ago(ofHead.queuedAt)}.`
          : job
            ? `The last review here was of ${job.head.slice(0, 7)}, before the newest commits.`
            : "ocra has not reviewed this pull request on this server."}
      </span>
      <Button type="button" variant="outline" disabled={active} loading={ask.busy} onClick={send}>
        {reviewed ? "Review again" : "Review now"}
      </Button>
      {ask.error !== null && (
        <p className="error" role="alert">
          Could not ask for a review: {why(ask.error)}.
        </p>
      )}
    </section>
  );
}
