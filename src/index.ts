import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.js";
import { enforceRetention } from "./db/retention.js";

// The Cloudflare Worker: D1, its rate limiting bindings and the daily cron.
export const app = createApp({
  openDb: (env: Env) => drizzle(env.DB),
  // Set by Cloudflare's edge, which drops any value the client sent.
  clientAddress: (c) => c.req.header("cf-connecting-ip"),
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(enforceRetention(drizzle(env.DB)));
  },
} satisfies ExportedHandler<Env>;
