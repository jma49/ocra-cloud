import { type Scoped, scoped } from "../db/scoped.js";
import { errorName, logError } from "../log.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { WorkSource } from "./work.js";

// The label a pull request carries while its fix loop works for `@ocra fix`
// (./commands.ts): put on when the command queues a round, and taken off
// once no round waits or runs, so whoever opens it sees that ocra is fixing.

export const FIXING_LABEL = "ocra: fixing";

type Pull = {
  platform: CodePlatform;
  token: string;
  fullName: string;
  reviewRepoId: string;
  number: number;
};

/** Takes the label off the pull request once its loop is idle, when the bot put it on. */
export async function unlabelIdle(data: Scoped, pull: Pull): Promise<void> {
  if (!(await data.mends.unlabel(pull.reviewRepoId, pull.number))) return;
  const removed = await pull.platform.edits.editLabels(pull.token, pull.fullName, pull.number, {
    add: [],
    remove: [FIXING_LABEL],
  });
  if (removed !== "done") logError("fix_label_left", { outcome: removed ?? "unreached" });
}

/** As unlabelIdle, for the loop of a job a run settled, as the bot of its repository. */
export async function unlabelJob(
  source: Pick<WorkSource, "db"> & Partial<Pick<WorkSource, "platforms" | "bots">>,
  accountId: string,
  jobId: string,
): Promise<void> {
  const { platforms, bots } = source;
  if (!platforms || !bots) return;
  try {
    const data = scoped(source.db, accountId);
    const job = await data.get("mendJobs", jobId);
    if (!job?.labeled) return;
    const repo = await data.get("reviewRepos", job.reviewRepoId);
    const platform =
      repo && platforms.find((p) => p.kind === repo.platform && p.host === repo.host);
    const bot = platform && (await bots.forRepo(repo));
    if (!repo || !platform || !bot) return;
    await unlabelIdle(data, {
      platform,
      token: bot.token,
      fullName: repo.fullName,
      reviewRepoId: repo.id,
      number: job.number,
    });
  } catch (e) {
    logError("fix_label_failed", { job: jobId, error: errorName(e) });
  }
}
