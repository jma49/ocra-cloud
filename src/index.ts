import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { account } from "./account.js";
import { auth } from "./auth.js";
import { BodyTooLarge } from "./body.js";
import { enforceRetention } from "./db/retention.js";
import { device } from "./device.js";
import { exportRoute } from "./export.js";
import { gateway } from "./gateway.js";
import { keys } from "./keys.js";
import { me } from "./me.js";
import { memory } from "./memory.js";
import { preferences } from "./preferences.js";
import { type ProviderName, providerInfo, providers } from "./providers.js";
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

app.get("/health", async (c) => {
  const row = await c.env.DB.prepare("select 1 as ok").first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1 });
});

app.route("/auth", auth);
app.route("/device", device);

// The providers and paths the gateway forwards, for the web app and the CLI.
app.get("/providers", (c) =>
  c.json({
    providers: Object.entries(providers).map(([name, p]) => ({
      name,
      ...providerInfo[name as ProviderName],
      base: p.base,
      paths: p.routes.map((r) => (typeof r.path === "string" ? r.path : r.path.source)),
      // How the CLI's direct runtime sends a reasoning effort: OpenRouter
      // takes `reasoning.effort`; the rest the OpenAI-style default.
      ...(name === "openrouter" ? { effort: "openrouter" } : {}),
    })),
  }),
);

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

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof BodyTooLarge) return c.json({ error: "body_too_large" }, 413);
  // The message only: an error may quote a request, and bodies are never logged.
  console.error(`api error on ${c.req.method} ${c.req.routePath}: ${err.name}`);
  return c.json({ error: "internal" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(enforceRetention(drizzle(env.DB)));
  },
} satisfies ExportedHandler<Env>;
