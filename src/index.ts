import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", async (c) => {
  const row = await c.env.DB.prepare("select 1 as ok").first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1 });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
