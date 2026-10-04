import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { SESSION_COOKIE } from "./auth.js";
import { deleteAccount } from "./db/accounts.js";
import type { AppEnv } from "./types.js";

// The signed-in account: usage, sessions, and deleting it all.

export const account = new Hono<AppEnv>();

const DAY = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

account.get("/usage", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "14") || 14, 1), 90);
  const todayStart = new Date(utcDay(new Date()));
  const since = new Date(todayStart.getTime() - (days - 1) * DAY);
  const calls = await c.var.data.listSince("gatewayCalls", since);

  type Day = {
    day: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    errors: number;
    byModel: Record<string, { calls: number; tokens: number }>;
  };
  const series = new Map<string, Day>();
  for (let i = 0; i < days; i++) {
    const day = utcDay(new Date(since.getTime() + i * DAY));
    series.set(day, { day, calls: 0, tokensIn: 0, tokensOut: 0, errors: 0, byModel: {} });
  }
  const models = new Map<
    string,
    { model: string; provider: string; calls: number; tokensIn: number; tokensOut: number }
  >();
  for (const call of calls) {
    const name = call.model ?? "(unknown)";
    const d = series.get(utcDay(call.createdAt));
    if (d) {
      d.calls++;
      d.tokensIn += call.tokensIn;
      d.tokensOut += call.tokensOut;
      if (call.status >= 400) d.errors++;
      const m = d.byModel[name] ?? { calls: 0, tokens: 0 };
      m.calls++;
      m.tokens += call.tokensIn + call.tokensOut;
      d.byModel[name] = m;
    }
    const key = `${call.provider}\u0000${name}`;
    const m = models.get(key) ?? {
      model: name,
      provider: call.provider,
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    m.calls++;
    m.tokensIn += call.tokensIn;
    m.tokensOut += call.tokensOut;
    models.set(key, m);
  }
  const today = series.get(utcDay(todayStart));
  return c.json({
    days,
    today: today?.calls ?? 0,
    dailyLimit: Number(c.env.GATEWAY_DAILY_CALLS),
    series: [...series.values()],
    models: [...models.values()].sort((a, b) => b.calls - a.calls),
    calls: calls.slice(0, 200).map(({ accountId: _a, ...call }) => call),
  });
});

account.get("/sessions", async (c) => {
  const rows = await c.var.data.list("sessions");
  const now = Date.now();
  return c.json({
    sessions: rows
      .filter((s) => (s.refreshExpiresAt ?? s.expiresAt).getTime() > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        label: s.label,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.refreshExpiresAt ?? s.expiresAt,
        current: s.id === c.var.session.sessionId,
      })),
  });
});

account.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const removed = await c.var.data.remove("sessions", id);
  if (removed && id === c.var.session.sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ removed });
});

// Everything stored for the account, as JSON. Keys are listed by provider
// and last four characters; their encrypted values stay on the server.
account.get("/export", async (c) => {
  const d = c.var.data;
  const strip = <T extends { accountId: string }>(rows: T[]) =>
    rows.map(({ accountId: _a, ...r }) => r);
  const keys = (await d.list("providerKeys")).map((k) => ({
    provider: k.provider,
    last4: k.last4,
    checkStatus: k.checkStatus,
    createdAt: k.createdAt,
  }));
  const sessionsList = (await d.list("sessions")).map((s) => ({
    kind: s.kind,
    label: s.label,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.refreshExpiresAt ?? s.expiresAt,
  }));
  const { account: a } = c.var.session;
  c.header("content-disposition", 'attachment; filename="ocra-cloud-export.json"');
  return c.json({
    exportedAt: new Date(),
    account: { login: a.login, githubId: a.githubId, createdAt: a.createdAt },
    providerKeys: keys,
    sessions: sessionsList,
    preferences: strip(await d.list("preferences")),
    reviews: strip(await d.list("reviews")),
    gatewayCalls: strip(await d.list("gatewayCalls")),
    auditEvents: strip(await d.list("auditEvents")),
  });
});

account.delete("/account", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== c.var.session.account.login) {
    return c.json({ error: "confirm_with_login" }, 400);
  }
  await deleteAccount(c.var.db, c.var.session.account.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ deleted: true });
});
