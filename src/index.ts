import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.js";
import { enforceRetention } from "./db/retention.js";
import { masterKeys } from "./keyring.js";
import { runDigests } from "./notify/digest.js";

// The Cloudflare Worker: D1, its rate limiting bindings and the daily cron.
// It has no mailer: no email API is configured for it, so the digest goes
// to its chats only.
export const app = createApp({
  openDb: (env: Env) => drizzle(env.DB),
  // Set by Cloudflare's edge, which drops any value the client sent.
  clientAddress: (c) => c.req.header("cf-connecting-ip"),
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    const db = drizzle(env.DB);
    ctx.waitUntil(enforceRetention(db));
    if (env.PUBLIC_URL) {
      const out = {
        keys: masterKeys(env),
        mailer: undefined,
        linkSecret: env.SESSION_SECRET,
        origin: new URL(env.PUBLIC_URL).origin,
      };
      ctx.waitUntil(runDigests(db, out));
    }
  },
} satisfies ExportedHandler<Env>;
