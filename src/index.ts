import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { auth, requireSession } from "./auth.js";
import { gateway } from "./gateway.js";
import { keys } from "./keys.js";
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

app.get("/me", requireSession(), (c) => {
  const { account, kind } = c.var.session;
  return c.json({ login: account.login, githubId: account.githubId, session: kind });
});

// The account's recent gateway calls (its key-use log) and today's count.
app.get("/usage", requireSession(), async (c) => {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const calls = (await c.var.data.list("gatewayCalls"))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 50);
  return c.json({
    today: await c.var.data.countSince("gatewayCalls", today),
    dailyLimit: Number(c.env.GATEWAY_DAILY_CALLS),
    calls: calls.map(({ accountId: _a, ...call }) => call),
  });
});

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
