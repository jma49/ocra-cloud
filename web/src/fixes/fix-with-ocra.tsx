import Wrench from "lucide-react/icons/wrench";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  type FixJobView,
  type FixRequestView,
  MAX_DAILY_FIX_REQUESTS,
  type PullFindingView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useAction } from "../ui.js";
import { useFixJobs } from "./fix-jobs.js";

type Reason = NonNullable<FixJobView["reason"]>;

const NO_FIX: Record<Reason, string> = {
  declined: "ocra saw no safe change that fixes this.",
  failed: "the fixer's call failed.",
  stale: "the code is no longer as the review read it.",
  unchanged: "the fix it wrote changed nothing.",
  unsafe: "the fix it wrote did not pass the safety check.",
  too_large: "the fix it wrote was too large.",
  no_parser: "this file's language has no parser to check a fix with.",
  syntax: "the fix it wrote did not parse.",
  not_candidate: "this finding is not one ocra writes a fix for.",
};

/** Why a finished request left no fix, in a sentence; nothing for one that left one. */
function noFix(job: FixJobView): string | null {
  if (job.state !== "done" || job.outcome === "proposed") return null;
  if (job.outcome === "head_moved") {
    return "No fix: the pull request has newer commits than the review. Review it again first.";
  }
  return `No fix: ${job.reason ? NO_FIX[job.reason] : "ocra gave no reason."}`;
}

const refused = (e: unknown) =>
  e instanceof ApiError && e.code === "daily_limit"
    ? `Today's ${MAX_DAILY_FIX_REQUESTS} fixes are used up. Ask again tomorrow.`
    : `Could not ask for a fix: ${why(e)}`;

/**
 * Asks ocra for a fix of a finding that came without one, and says how the
 * request stands. Nothing where no fix can be asked for: outside a
 * repository ocra reviews, for a finding ocra is unsure of, or one with a fix.
 */
export function FixWithOcra(props: { finding: PullFindingView }) {
  const { finding: f } = props;
  const jobs = useFixJobs();
  const job = jobs.of(f.id);
  const ask = useAction(async () => {
    await api<FixRequestView>("/auto-review/fixes", {
      method: "POST",
      body: JSON.stringify({ finding: f.id }),
    });
    jobs.reload();
  });
  if (!jobs.enrolled || f.lowConfidence || f.hasFix) return null;

  if (job?.state === "queued" || job?.state === "running") {
    return (
      <span role="status">
        <Status tone="run">{job.state === "queued" ? "Fix queued" : "Writing a fix"}</Status>
      </span>
    );
  }
  if (job?.state === "done" && job.outcome === "proposed") {
    return (
      <span role="status">
        <Status tone="ok">Fix proposed</Status>
      </span>
    );
  }
  const said = job && noFix(job);
  if (said) {
    return (
      <span className="subtle small" role="status">
        {said}
      </span>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" disabled={ask.busy} onClick={() => void ask.run()}>
        <Wrench size={14} aria-hidden="true" />
        {job?.state === "failed" ? "Try the fix again" : "Fix with ocra"}
      </Button>
      {ask.error != null ? (
        <span className="error small" role="alert">
          {refused(ask.error)}
        </span>
      ) : (
        job?.state === "failed" && (
          <span className="error small" role="status">
            The fix run failed.
          </span>
        )
      )}
    </>
  );
}
