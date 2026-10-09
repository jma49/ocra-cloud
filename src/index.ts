import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { account } from "./account.js";
import { auth } from "./auth.js";
import { BodyTooLarge } from "./body.js";
import { enforceRetention } from "./db/retention.js";
import { device } from "./device.js";
import { exportRoute } from "./export.js";
import { gateway } from "./gateway.js";
import { apiError } from "./http.js";
import { keys } from "./keys.js";
import { me } from "./me.js";
import { memory } from "./memory.js";
import { preferences } from "./preferences.js";
import { providersRoute } from "./providers.js";
import { reviews } from "./reviews.js";
import { sessions } from "./sessions.js";
import type { AppEnv } from "./types.js";
import { usage } from "./usage.js";

export const app = new Hono<AppEnv>().basePath("/api");

/**
 * On every API answer, errors included: never read as another type, never
 * framed, and no referrer. The web app's own headers are in web/public/_headers.
 */
export const API_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

app.use(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(API_HEADERS)) c.res.headers.set(name, value);
});

app.use(async (c, next) => {
  c.set("db", drizzle(c.env.DB));
  await next();
});

// Needs no session, so it reads nothing: on the Free plan D1's rows are a
// daily quota shared by every account (audit C1).
app.get("/health", (c) => c.json({ ok: true }));

app.route("/auth", auth);
app.route("/device", device);

app.route("/providers", providersRoute);

// Every router applies its own session guard (test/routes.test.ts checks
// each route): this file only composes them.
app.route("/me", me);
app.route("/usage", usage);
app.route("/sessions", sessions);
app.route("/export", exportRoute);
app.route("/account", account);
app.route("/reviews", reviews);
app.route("/preferences", preferences);
app.route("/memory", memory);
app.route("/keys", keys);
app.route("/gateway", gateway);

app.notFound((c) => apiError(c, "not_found"));
app.onError((err, c) => {
  if (err instanceof BodyTooLarge) return apiError(c, "body_too_large");
  // The message only: an error may quote a request, and bodies are never logged.
  console.error(`api error on ${c.req.method} ${c.req.routePath}: ${err.name}`);
  return apiError(c, "internal");
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(enforceRetention(drizzle(env.DB)));
  },
} satisfies ExportedHandler<Env>;
