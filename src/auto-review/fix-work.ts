import type { FixResult } from "@open-cr-agent/cloud-contract";
import { audit } from "../audit.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { fixNotice } from "../notify/feed.js";
import { type RunFailure, settle, type WorkSource } from "./work.js";

// The server's half of "fix with ocra" past the run (./work.ts claims and
// prepares it as any hosted job): what `ocra fix --json` answered, checked
// against the request, recorded on it, and a proposed fix written into the
// finding's fix columns, where the pull request page commits it. The
// machine's half is src/node/review-runner.ts (runFix).

/** The job a fix's run answers for: settled only while it is still this attempt's. */
export type FixRef = { id: string; accountId: string; attempts: number };

/** How a fix's run ended: `ocra fix`'s answer, or the failure to retry. */
export type FixRan = { result: FixResult } | { failure: RunFailure };

export async function settleFix(
  source: Pick<WorkSource, "db" | "dailyCalls">,
  ref: FixRef,
  ran: FixRan,
  now: Date,
): Promise<void> {
  const work = { ...ref, kind: "fix" as const };
  if ("failure" in ran) return settle(source, work, ran.failure, now);
  const data = scoped(source.db, ref.accountId);
  const job = await data.get("fixJobs", ref.id);
  const finding = job && (await data.get("findings", job.findingId));
  const { result } = ran;
  // An answer for another finding or head is not this request's: the run failed.
  const answers =
    job &&
    finding &&
    result.fingerprint === finding.fingerprint &&
    (result.outcome === "head_moved" || result.headSha === job.head);
  if (!job || !finding || !answers) return settle(source, work, "review_failed", now);
  const recorded = await data.fixes.finish(
    ref.id,
    ref.attempts,
    { outcome: result.outcome, reason: result.reason, fix: result.fix },
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
