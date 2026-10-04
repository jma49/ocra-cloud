import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { account } from "./account.js";
import { auth, requireSession } from "./auth.js";
import { device } from "./device.js";
import { gateway } from "./gateway.js";
import { keys } from "./keys.js";
import { memory } from "./memory.js";
import { preferences } from "./preferences.js";
import { type ProviderName, providerInfo, providers } from "./providers.js";
import { enforceRetention } from "./retention.js";
import { reviews } from "./reviews.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>().basePath("/api");

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

app.get("/me", requireSession(["web", "cli"]), (c) => {
  const { account: a, kind } = c.var.session;
  return c.json({ login: a.login, githubId: a.githubId, session: kind, since: a.createdAt });
});

app.use("/usage", requireSession());
app.use("/sessions/*", requireSession());
app.use("/sessions", requireSession());
app.use("/account", requireSession());
app.use("/account/sharing", requireSession());
app.use("/account/salt", requireSession(["web", "cli"]));
app.use("/export", requireSession());
app.route("/", account);

app.route("/reviews", reviews);
app.route("/preferences", preferences);
app.route("/memory", memory);

app.use("/keys/*", requireSession());
app.route("/keys", keys);
app.use("/gateway/*", requireSession(["web", "cli"]));
app.route("/gateway", gateway);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
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
