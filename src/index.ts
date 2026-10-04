import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { account } from "./account.js";
import { auth, requireSession } from "./auth.js";
import { gateway } from "./gateway.js";
import { keys } from "./keys.js";
import { type ProviderName, providerInfo, providers } from "./providers.js";
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

// The providers and paths the gateway forwards, for the web app and the CLI.
app.get("/providers", (c) =>
  c.json({
    providers: Object.entries(providers).map(([name, p]) => ({
      name,
      ...providerInfo[name as ProviderName],
      base: p.base,
      paths: p.routes.map((r) => (typeof r.path === "string" ? r.path : r.path.source)),
    })),
  }),
);

app.get("/me", requireSession(), (c) => {
  const { account: a, kind } = c.var.session;
  return c.json({ login: a.login, githubId: a.githubId, session: kind, since: a.createdAt });
});

app.use("/usage", requireSession());
app.use("/sessions/*", requireSession());
app.use("/sessions", requireSession());
app.use("/account", requireSession());
app.route("/", account);

app.use("/keys/*", requireSession());
app.route("/keys", keys);
app.use("/gateway/*", requireSession());
app.route("/gateway", gateway);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  // The message only: an error may quote a request, and bodies are never logged.
  console.error(`api error on ${c.req.method} ${c.req.routePath}: ${err.name}`);
  return c.json({ error: "internal" }, 500);
});

export default app;
