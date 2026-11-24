import Wrench from "lucide-react/icons/wrench";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  type FixJobView,
  type FixRequestView,
  MAX_DAILY_FIX_REQUESTS,
  type MendItemView,
  type MendRequestView,
  type PullFindingView,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useAction } from "../ui.js";
import { useFixJobs } from "./fix-jobs.js";

type Reason = NonNullable<FixJobView["reason"]>;

const NO_FIX: Record<Reason, string> = {
  declined: "ocra saw no safe change that fixes this.",
  failed: "ocra's call to the model did not go through.",
  stale: "the code is no longer as the review read it.",
  unchanged: "the fix it wrote changed nothing.",
  unsafe: "the fix it wrote did not pass the safety check.",
  too_large: "the fix it wrote was too large.",
  no_parser: "this file's language has no parser to check a fix with.",
  syntax: "the fix it wrote did not parse.",
  not_candidate: "this finding is not one ocra writes a fix for.",
};

type Cause = NonNullable<FixJobView["cause"]>;

/** What failed in the fixer's call, in place of the plain "did not go through". */
const FAILED: Record<Cause, string> = {
  timeout: "the model took too long to answer.",
  quota: "the model's quota or rate limit is used up.",
  refused: "the model's endpoint refused the request. Check the key and the model's name.",
  unavailable: "the model's endpoint could not be reached.",
  invalid_output: "the model's answer was not in the form ocra asked for.",
  unknown: NO_FIX.failed,
};

/** A reason in words, with what failed where the run said. */
const said = <R extends string>(
  words: Record<R, string>,
  reason: R | null,
  cause: Cause | null,
): string =>
  reason === "failed" && cause ? FAILED[cause] : reason ? words[reason] : "ocra gave no reason.";

type MendReason = NonNullable<MendItemView["reason"]>;

const NOT_MENDED: Record<MendReason, string> = {
  ...NO_FIX,
  out_of_scope: "it needs a file outside this pull request.",
  protected: "it needs a file ocra does not edit.",
  tamper: "the fix it wrote weakened a test or a check.",
  unresolved: "the fix it wrote did not pass ocra's check of it.",
  unsure: "ocra could not tell that its fix was right.",
  unchecked: "the check of its fix failed.",
  overlap: "it touches the lines of another fix in the same round.",
  no_room: "the round was full.",
  attempts: "ocra tried twice.",
  head_moved: "the branch moved while ocra worked.",
  not_writable: "ocra cannot write to this branch.",
};

/** Outcomes that close a finding for the loop: asking again changes nothing. */
const CLOSED: ReadonlySet<MendItemView["outcome"]> = new Set(["needs_human", "gone"]);

/** Why the loop committed no fix for it, in a sentence. */
const notMended = (item: MendItemView) =>
  `No fix: ${said(NOT_MENDED, item.reason, item.cause)}${
    item.outcome === "needs_human" ? " This one is for a person." : ""
  }`;

/** Why a finished request left no fix, in a sentence; nothing for one that left one. */
function noFix(job: FixJobView): string | null {
  if (job.state !== "done" || job.outcome === "proposed") return null;
  if (job.outcome === "head_moved") {
    return "No fix: the pull request has newer commits than the review. Review it again first.";
  }
  return `No fix: ${said(NO_FIX, job.reason, job.cause)}`;
}

/** A request that can be asked again: its run failed, or the fixer's call to the model did. */
const retriable = (job: FixJobView) =>
  job.state === "failed" || (job.state === "done" && job.reason === "failed");

const refused = (e: unknown) =>
  e instanceof ApiError && e.code === "daily_limit"
    ? `Today's ${MAX_DAILY_FIX_REQUESTS} fixes are used up. Ask again tomorrow.`
    : `Could not ask for a fix: ${why(e)}`;

/**
 * Asks ocra for a fix of a finding that came without one, and says how the
 * request stands. Where the repository lets ocra commit, the request goes to
 * the pull request's fix loop, which commits the fix to the branch. Nothing
 * where no fix can be asked for: outside a
 * repository ocra reviews, for a finding ocra is unsure of, or one with a fix.
 */
export function FixWithOcra(props: { finding: PullFindingView }) {
  const { finding: f } = props;
  const jobs = useFixJobs();
  const job = jobs.of(f.id);
  const asked = jobs.commits ? jobs.mendOf(f.id) : undefined;
  const ask = useAction(async () => {
    if (jobs.commits) {
      await api<MendRequestView>("/auto-review/mends", {
        method: "POST",
        body: JSON.stringify({ findings: [f.id] }),
      });
    } else {
      await api<FixRequestView>("/auto-review/fixes", {
        method: "POST",
        body: JSON.stringify({ finding: f.id }),
      });
    }
    jobs.reload();
  });
  if (!jobs.enrolled || f.lowConfidence || f.hasFix) return null;

  if (asked) {
    if (!asked.outcome) {
      return (
        <span role="status">
          <Status tone="run">{jobs.mending ? "Fixing" : "Fix queued"}</Status>
        </span>
      );
    }
    if (asked.outcome === "fixed") {
      return (
        <span role="status">
          <Status tone="ok">
            Fixed{asked.commit && <span className="mono"> {asked.commit.slice(0, 7)}</span>}
          </Status>
        </span>
      );
    }
    if (CLOSED.has(asked.outcome)) {
      return (
        <span className="subtle small" role="status">
          {notMended(asked)}
        </span>
      );
    }
    return (
      <>
        <Button size="sm" variant="outline" disabled={ask.busy} onClick={() => void ask.run()}>
          <Wrench size={14} aria-hidden="true" />
          Try the fix again
        </Button>
        <span className={ask.error != null ? "error small" : "subtle small"} role="status">
          {ask.error != null ? refused(ask.error) : notMended(asked)}
        </span>
      </>
    );
  }

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
  const again = job !== undefined && retriable(job);
  const said = job && (job.state === "failed" ? "The fix run failed." : noFix(job));
  if (said && !again) {
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
        {again ? "Try the fix again" : "Fix with ocra"}
      </Button>
      {ask.error != null ? (
        <span className="error small" role="alert">
          {refused(ask.error)}
        </span>
      ) : (
        said && (
          <span className="error small" role="status">
            {said}
          </span>
        )
      )}
    </>
  );
}
