import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.js";
import { remoteReviews } from "./auto-review/remote.js";
import { retryAutomations } from "./automations/retry.js";
import { type CronJob, type CronJobName, runScheduled } from "./cron-calls.js";
import { pruneGraphBuilds } from "./db/graphs.js";
import { recoverJobs } from "./db/job-recovery.js";
import { enforceRetention } from "./db/retention.js";
import { remoteGraphs } from "./graph/remote.js";
import { retryInbound } from "./inbound/run.js";
import { masterKeys } from "./keyring.js";
import { sweepMergeIntents } from "./merge-when-ready/advance.js";
import { runAtRisk } from "./notify/at-risk.js";
import { runDigests } from "./notify/digest.js";
import { runHeld } from "./notify/held.js";
import { retryNotifications } from "./notify/notify.js";
import { runReminders } from "./notify/reminders.js";
import { runReports } from "./notify/report.js";
import { githubHostOf, platformsOf } from "./platforms/registry.js";
import { reconcileRun } from "./reconcile.js";
import { sweepStackMerges } from "./stack-merge/advance.js";

// The Cloudflare Worker: D1, its rate limiting bindings and its crons: the
// daily one runs retention, the hourly one (HOURLY, in wrangler.jsonc) the
// digests, weekly reports, review reminders, the notices held in quiet
// hours and the pull requests at risk of a review target, which the database lets go once, and the webhook deliveries,
// outgoing and incoming, and the automation rules' writes due again, the
// merge-when-ready intents and stack merges left waiting and the daily
// reconciliation of enrolled repositories (so on the Worker a retry
// waits for the hour), all within one budget of external calls
// (src/cron-calls.ts). It has no mailer: no email API is
// configured for it, so they go to its chats only. It runs no hosted job
// itself: with a runner token and the GitHub App's key and webhook secret,
// GitLab's bot token or both, it queues them for remote runners
// (docs/runner.md), which also build
// the code graphs it keeps (src/graph/remote.ts) unless CODE_GRAPH is off.
const HOURLY = "47 * * * *";
const remote = remoteReviews(env);
const graphs = "runnerToken" in remote ? remoteGraphs(env) : undefined;
export const app = createApp({
  openDb: (env: Env) => drizzle(env.DB),
  // Set by Cloudflare's edge, which drops any value the client sent.
  clientAddress: (c) => c.req.header("cf-connecting-ip"),
  ...remote,
  ...(graphs ? { graphs } : {}),
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const db = drizzle(env.DB);
    const jobs: Partial<Record<CronJobName, CronJob>> = {};
    if (controller.cron !== HOURLY) {
      ctx.waitUntil(enforceRetention(db));
      ctx.waitUntil(recoverJobs(db));
      ctx.waitUntil(pruneGraphBuilds(db, graphs !== undefined));
    } else {
      const bots = "bots" in remote ? remote.bots : undefined;
      const platforms = platformsOf(env, env.PUBLIC_URL || "https://localhost");
      jobs.deliveries = (calls) =>
        retryNotifications(
          db,
          { keys: masterKeys(env), mailer: undefined, slack: env.SLACK_BOT_TOKEN },
          undefined,
          calls,
        );
      jobs.inbound = (calls) => retryInbound({ db, env, bots }, undefined, calls);
      // The bot's writes for the automation rules that the platform did not answer.
      if (bots) {
        jobs.automations = (calls) => retryAutomations({ db, bots, platforms }, undefined, calls);
      }
      // An armed intent's webhooks move it too; this reads again one they left armed.
      const out = {
        keys: masterKeys(env),
        mailer: undefined,
        linkSecret: env.SESSION_SECRET,
        slack: env.SLACK_BOT_TOKEN,
        origin: new URL(env.PUBLIC_URL || "https://localhost").origin,
      };
      jobs.mergeIntents = (calls) =>
        sweepMergeIntents({ db, env, platforms, out }, undefined, calls);
      // A stack merge's webhooks move it; this picks up one whose webhooks did not come.
      jobs.stackMerges = (calls) => sweepStackMerges({ db, env, platforms }, undefined, calls);
      // What webhooks missed, each enrolled repository read once a day (src/reconcile.ts).
      jobs.reconcile = reconcileRun({ db, env, platforms, bots });
    }
    if (env.PUBLIC_URL) {
      const out = {
        keys: masterKeys(env),
        mailer: undefined,
        linkSecret: env.SESSION_SECRET,
        slack: env.SLACK_BOT_TOKEN,
        origin: new URL(env.PUBLIC_URL).origin,
      };
      jobs.digests = (calls) => runDigests(db, out, undefined, calls);
      jobs.reports = (calls) => runReports(db, out, undefined, calls);
      jobs.reminders = (calls) => runReminders(db, out, githubHostOf(env).host, undefined, calls);
      jobs.held = (calls) => runHeld(db, out, undefined, calls);
      jobs.atRisk = (calls) => runAtRisk(db, out, undefined, calls);
    }
    // Every job's external calls share the invocation's budget (src/cron-calls.ts).
    ctx.waitUntil(runScheduled(jobs));
  },
} satisfies ExportedHandler<Env>;
