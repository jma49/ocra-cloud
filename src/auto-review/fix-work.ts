import { fixResultSchema } from "@open-cr-agent/cloud-contract";
import { audit } from "../audit.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { fixNotice } from "../notify/feed.js";
import { settle, type WorkRef, type WorkSource } from "./work.js";

// The server's half of "fix with ocra" past the run (./work.ts claims and
// prepares it as any answered job, ./answers.ts hands its answer here):
// what `ocra fix --json` printed, read with the contract's fixResultSchema,
// checked against the request, recorded on it, and a proposed fix written
// into the finding's fix columns, where the pull request page commits it.

/** Records the answer of the fix's run that printed it; one that is not a fix's, or this request's, fails the run. */
export async function settleFixAnswer(
  source: Pick<WorkSource, "db" | "dailyCalls">,
  ref: WorkRef,
  answer: unknown,
  now: Date,
): Promise<void> {
  const parsed = fixResultSchema.safeParse(answer);
  if (!parsed.success) {
    logError("fix_answer_unreadable", { job: ref.id });
    return settle(source, ref, "review_failed", now);
  }
  const data = scoped(source.db, ref.accountId);
  const job = await data.get("fixJobs", ref.id);
  const finding = job && (await data.get("findings", job.findingId));
  const result = parsed.data;
  // An answer for another finding or head is not this request's: the run failed.
  const answers =
    job &&
    finding &&
    result.fingerprint === finding.fingerprint &&
    (result.outcome === "head_moved" || result.headSha === job.head);
  if (!job || !finding || !answers) return settle(source, ref, "review_failed", now);
  const recorded = await data.fixes.finish(
    ref.id,
    ref.attempts,
    { outcome: result.outcome, reason: result.reason, cause: result.cause, fix: result.fix },
    now,
  );
  await data.remove("sessions", ref.id).catch(() => {});
  if (!recorded) return;
  try {
    const repo = await data.get("reviewRepos", job.reviewRepoId);
    if (!repo) return;
    const pull = `${repo.fullName}#${job.number}`;
    await audit(data, "pull.fix_answered", {
      pull,
      finding: finding.id,
      outcome: result.outcome,
    });
    await data.feed.record([
      fixNotice(
        { id: job.id, outcome: result.outcome, reason: result.reason, finishedAt: now },
        finding,
        repo,
        job.number,
      ),
    ]);
  } catch (e) {
    logError("fix_follow_up_failed", { job: ref.id, error: errorName(e) });
  }
}
