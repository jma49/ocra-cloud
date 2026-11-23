import { CallBudget, withCalls } from "./calls.js";
import { errorName, logError } from "./log.js";

// The Worker's scheduled run, within one budget of external calls: the
// Workers Free plan allows 50 subrequests per invocation (D1's are counted
// apart), and a run that makes more fails. Each job first runs within its
// share, all at once; then each job that wanted more runs again, one after
// another in the order below, on what the others left. The work that can
// wait comes last, so it yields first: the armed merge-when-ready intents
// and the stack merges (their webhooks move them, the sweeps only pick up
// what they missed) and the daily
// reconciliation with the sweep of GitLab groups' new projects (a repository
// or group not read this hour is read in a later one).

/** The calls one scheduled run makes at most, safely under the plan's 50. */
export const WORKER_CALLS = 45;

/** Each job's share, in the order the second round runs them; together WORKER_CALLS. */
export const WORKER_SHARES = {
  deliveries: 6,
  inbound: 6,
  automations: 4,
  held: 3,
  reminders: 3,
  atRisk: 3,
  digests: 3,
  reports: 3,
  mergeIntents: 4,
  stackMerges: 4,
  reconcile: 6,
} as const;

export type CronJobName = keyof typeof WORKER_SHARES;
/** A job of the run: it checks `calls` before each piece of work it claims. */
export type CronJob = (calls: CallBudget) => Promise<unknown>;

async function run(name: CronJobName, job: CronJob, calls: CallBudget): Promise<boolean> {
  try {
    await withCalls(calls, () => job(calls));
    return true;
  } catch (e) {
    logError("scheduled_job_failed", { job: name, error: errorName(e) });
    return false;
  }
}

/** Runs the jobs given, those left out taking no share; the calls made in all. */
export async function runScheduled(
  jobs: Partial<Record<CronJobName, CronJob>>,
  total = WORKER_CALLS,
): Promise<number> {
  const all = new CallBudget(total);
  const order = (Object.keys(WORKER_SHARES) as CronJobName[]).flatMap((name) => {
    const job = jobs[name];
    return job ? [{ name, job, calls: all.child(WORKER_SHARES[name]) }] : [];
  });
  const ran = await Promise.all(order.map((j) => run(j.name, j.job, j.calls)));
  for (const [i, j] of order.entries()) {
    if (!ran[i] || !j.calls.short || !all.has()) continue;
    await run(j.name, j.job, all.child());
  }
  return all.spent;
}
