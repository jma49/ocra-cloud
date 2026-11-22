import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.js";
import { enforceRetention } from "./db/retention.js";
import { masterKeys } from "./keyring.js";
import { runDigests } from "./notify/digest.js";
import { runHeld } from "./notify/held.js";
import { runReminders } from "./notify/reminders.js";
import { runReports } from "./notify/report.js";
import { githubHostOf } from "./platforms/registry.js";

// The Cloudflare Worker: D1, its rate limiting bindings and its crons: the
// daily one runs retention, the hourly one (HOURLY, in wrangler.jsonc) the
// digests, weekly reports, review reminders and the notices held in quiet
// hours, which the database lets go once. It has no mailer: no email API is
// configured for it, so they go to its chats only.
const HOURLY = "47 * * * *";
export const app = createApp({
  openDb: (env: Env) => drizzle(env.DB),
  // Set by Cloudflare's edge, which drops any value the client sent.
  clientAddress: (c) => c.req.header("cf-connecting-ip"),
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const db = drizzle(env.DB);
    if (controller.cron !== HOURLY) ctx.waitUntil(enforceRetention(db));
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
    }
  },
} satisfies ExportedHandler<Env>;
