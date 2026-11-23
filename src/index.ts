import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.js";
import { remoteReviews } from "./auto-review/remote.js";
import { enforceRetention } from "./db/retention.js";
import { retryInbound } from "./inbound/run.js";
import { masterKeys } from "./keyring.js";
import { runAtRisk } from "./notify/at-risk.js";
import { runDigests } from "./notify/digest.js";
import { runHeld } from "./notify/held.js";
import { retryNotifications } from "./notify/notify.js";
import { runReminders } from "./notify/reminders.js";
import { runReports } from "./notify/report.js";
import { githubHostOf, platformsOf } from "./platforms/registry.js";
import { reconcileRepos, WORKER_RECONCILE_CALLS } from "./reconcile.js";
import { sweepStackMerges } from "./stack-merge/advance.js";

// The Cloudflare Worker: D1, its rate limiting bindings and its crons: the
// daily one runs retention, the hourly one (HOURLY, in wrangler.jsonc) the
// digests, weekly reports, review reminders, the notices held in quiet
// hours and the pull requests at risk of a review target, which the database lets go once, and the webhook deliveries,
// outgoing and incoming, due again, the stack merges left waiting and the
// daily reconciliation of enrolled repositories (so on the Worker a retry waits for the hour). It has no mailer: no email API is
// configured for it, so they go to its chats only. It runs no hosted job
// itself: with the GitHub App's key, its webhook secret and a runner token
// set, it queues them for remote runners (docs/runner.md).
const HOURLY = "47 * * * *";
const remote = remoteReviews(env);
export const app = createApp({
  openDb: (env: Env) => drizzle(env.DB),
  // Set by Cloudflare's edge, which drops any value the client sent.
  clientAddress: (c) => c.req.header("cf-connecting-ip"),
  ...remote,
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const db = drizzle(env.DB);
    if (controller.cron !== HOURLY) ctx.waitUntil(enforceRetention(db));
    else {
      ctx.waitUntil(retryNotifications(db, { keys: masterKeys(env), mailer: undefined }));
      ctx.waitUntil(retryInbound({ db, env, bots: "bots" in remote ? remote.bots : undefined }));
      // A stack merge's webhooks move it; this picks up one whose webhooks did not come.
      const platforms = platformsOf(env, env.PUBLIC_URL || "https://localhost");
      ctx.waitUntil(sweepStackMerges({ db, env, platforms }));
      // What webhooks missed, each enrolled repository read once a day (src/reconcile.ts),
      // in a share of the invocation's subrequests.
      const bots = "bots" in remote ? remote.bots : undefined;
      ctx.waitUntil(reconcileRepos({ db, env, platforms, bots, calls: WORKER_RECONCILE_CALLS }));
    }
    if (env.PUBLIC_URL) {
      const out = {
        keys: masterKeys(env),
        mailer: undefined,
        linkSecret: env.SESSION_SECRET,
        origin: new URL(env.PUBLIC_URL).origin,
      };
      ctx.waitUntil(runDigests(db, out));
      ctx.waitUntil(runReports(db, out));
      ctx.waitUntil(runReminders(db, out, githubHostOf(env).host));
      ctx.waitUntil(runHeld(db, out));
      ctx.waitUntil(runAtRisk(db, out));
    }
  },
} satisfies ExportedHandler<Env>;
