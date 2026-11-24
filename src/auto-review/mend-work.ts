import { mendResultSchema } from "@open-cr-agent/cloud-contract";
import { audit } from "../audit.js";
import { scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import { mendNotice } from "../notify/feed.js";
import { settle, type WorkRef, type WorkSource } from "./work.js";

// The server's half of a pull request's fix loop (ADR-0078) past its run
// (./work.ts claims and prepares it as any answered job, ./mend-round.ts
// gives it the findings that wait, ./answers.ts hands its answer here):
// what a round of `ocra mend --level commit --json` printed, read with the
// contract's mendResultSchema and recorded on the loop and its findings. The bot commits; ocra runs nothing of the repository, and the
// pull request's own checks test the commit. The machine's half is
// src/node/review-runner.ts.

/** Records what the round's run printed; a line that is not a round's answer fails the run. */
export async function settleMendAnswer(
  source: Pick<WorkSource, "db" | "dailyCalls">,
  ref: WorkRef,
  answer: unknown,
  now: Date,
): Promise<void> {
  const parsed = mendResultSchema.safeParse(answer);
  if (!parsed.success) {
    logError("mend_answer_unreadable", { job: ref.id });
    return settle(source, ref, "review_failed", now);
  }
  const result = parsed.data;
  const data = scoped(source.db, ref.accountId);
  const fixed = await data.mends.finish(
    ref.id,
    ref.attempts,
    {
      outcome: result.outcome,
      commitSha: result.commitSha,
      loop: result.state,
      items: result.items,
    },
    now,
  );
  await data.remove("sessions", ref.id).catch(() => {});
  if (!fixed || !result.commitSha) return;
  try {
    await data.findingOutcomes.markFixed(fixed, "applied");
    const job = await data.get("mendJobs", ref.id);
    const repo = job && (await data.get("reviewRepos", job.reviewRepoId));
    if (!job || !repo) return;
    const commit = result.commitSha;
    const written = result.items.filter((item) => item.outcome === "fixed");
    // A commit holds fixes (of findings and of failed checks) or, alone, the merge of the base branch.
    const merged = written.filter((item) => item.conflict).length;
    const count = { fixed: written.length - merged, merged };
    await audit(data, "pull.mend_committed", {
      pull: `${repo.fullName}#${job.number}`,
      head: result.headSha,
      commit,
      ...count,
    });
    await data.feed.record([
      mendNotice({ id: job.id, commit, ...count, finishedAt: now }, repo, job.number),
    ]);
  } catch (e) {
    logError("mend_follow_up_failed", { job: ref.id, error: errorName(e) });
  }
}
