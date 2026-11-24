import ChevronDown from "lucide-react/icons/chevron-down";
import { useEffect, useRef, useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import type {
  PullReviewJobView,
  PullReviewNowView,
  ReviewDepth,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { DepthChoices } from "../auto-review/depth-menu.js";
import { DEPTH } from "../auto-review/depths.js";
import { useLimitReached } from "../auto-review/limit-reached.js";
import { useRead } from "../cache.js";
import { ago } from "../format.js";
import { usePageCommands } from "../page-commands.js";
import { Link } from "../router.js";
import { useAction, usePoll } from "../ui.js";

// An AI review of the pull request's current head by the server's runner,
// asked for inside the ocra review card. The server answers only for a
// repository this account enrolled for reviews; any other leads to enrolling it.
// The review takes the repository's depth unless the person picks another for it.

const STATE: Record<PullReviewJobView["state"], string> = {
  queued: "A review of this head is queued",
  running: "ocra is reviewing this head",
  done: "ocra reviewed this head",
  failed: "The review of this head failed",
};

/** How often the card looks again while a review is waiting or running. */
const POLL_MS = 10_000;

type Pull = { platform: string; repo: string; number: number };

export function ReviewNowBox(props: {
  pull: Pull;
  head: string;
  /** Once a review this card watched finishes: what the page shows of the review is out of date. */
  onReviewed?: () => void;
}) {
  const query = new URLSearchParams({
    platform: props.pull.platform,
    repo: props.pull.repo,
    number: String(props.pull.number),
  }).toString();
  const { data, error, reload } = useRead<PullReviewNowView>(`/pulls/review-now?${query}`);
  const [picked, setPicked] = useState<ReviewDepth | null>(null);
  const depth = picked ?? data?.depth ?? "standard";
  const ask = useAction((force: boolean) =>
    api<PullReviewNowView>("/pulls/review-now", {
      method: "POST",
      body: JSON.stringify({
        ...props.pull,
        force,
        ...(picked && picked !== data?.depth ? { depth: picked } : {}),
      }),
    }),
  );
  const limit = useLimitReached();
  const job = data?.job ?? null;
  const active = job?.state === "queued" || job?.state === "running";
  usePoll(active, reload, POLL_MS);
  const ofHead = job?.head === props.head ? job : null;
  const reviewed = ofHead?.state === "done";
  const watched = useRef(false);
  const { onReviewed } = props;
  useEffect(() => {
    if (active) watched.current = true;
    else if (watched.current) {
      watched.current = false;
      onReviewed?.();
    }
  }, [active, onReviewed]);
  const send = async () => {
    if (await ask.run(reviewed)) reload();
  };
  usePageCommands(
    "This pull request",
    data && !active && !ask.busy
      ? [
          {
            label: reviewed ? "Ask ocra to review again" : "Ask ocra to review",
            key: "a",
            run: send,
          },
        ]
      : [],
  );
  // The server answers 404 for a repository this account has not enrolled.
  if (!data && error instanceof ApiError && error.status === 404) {
    return (
      <div className="stack">
        <span className="subtle small">
          ocra reviews pull requests on this server for repositories with auto review on. This one
          is not among them.
        </span>
        <Link to="/auto-review" className="status-link">
          Set up auto review
        </Link>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="stack">
      <span className={ofHead?.state === "failed" ? "error small" : "subtle small"} role="status">
        {ofHead
          ? `${STATE[ofHead.state]}, asked ${ago(ofHead.queuedAt)}.`
          : job
            ? `The last review here was of ${job.head.slice(0, 7)}, before the newest commits.`
            : "ocra has not reviewed this pull request on this server."}
      </span>
      {limit && (
        <span className="small" role="status">
          <Status tone="warn">{limit.badge}</Status> {limit.why} A review asked now waits and starts{" "}
          {limit.resumes}. <Link to="/budget">Budget</Link>
        </span>
      )}
      <div className="row-gap">
        <Button
          type="button"
          variant="outline"
          className="grow"
          disabled={active}
          loading={ask.busy}
          onClick={send}
        >
          {reviewed ? "Review again" : "Review now"}
        </Button>
        <Menu>
          <MenuTrigger
            render={<Button type="button" variant="ghost" disabled={active} />}
            aria-label={`Depth of this review: ${DEPTH[depth].name}`}
          >
            {DEPTH[depth].name}
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start">
            <DepthChoices value={depth} onChange={setPicked} />
          </MenuPopup>
        </Menu>
      </div>
      {ask.error !== null && (
        <p className="error" role="alert">
          Could not ask for a review: {why(ask.error)}.
        </p>
      )}
    </div>
  );
}
