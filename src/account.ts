import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { SESSION_COOKIE } from "./auth.js";
import { accountSalt, deleteAccount, setSharing } from "./db/accounts.js";
import { audit } from "./keys.js";
import { clampDays } from "./retention.js";
import type { AppEnv } from "./types.js";

// The signed-in account: usage, sessions, and deleting it all.

export const account = new Hono<AppEnv>();

const DAY = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

account.get("/usage", async (c) => {
  const days = clampDays(c.req.query("days"), 14);
  const todayStart = new Date(utcDay(new Date()));
  const since = new Date(todayStart.getTime() - (days - 1) * DAY);
  // Summed in SQL (audit D5): exact however many calls there are.
  const [sums, latest] = await Promise.all([
    c.var.data.usage(since),
    c.var.data.listSince("gatewayCalls", since, 200),
  ]);

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
  for (const { day, ...totals } of sums.days) {
    const d = series.get(day);
    if (d) Object.assign(d, totals);
  }
  for (const { day, model, calls, tokens } of sums.dayModels) {
    const d = series.get(day);
    if (d) d.byModel[model] = { calls, tokens };
  }
  const today = series.get(utcDay(todayStart));
  return c.json({
    days,
    today: today?.calls ?? 0,
    dailyLimit: Number(c.env.GATEWAY_DAILY_CALLS),
    series: [...series.values()],
    models: sums.models,
    calls: latest.map(({ accountId: _a, ...call }) => call),
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
// and last four characters; their encrypted values stay on the server. The
// tables are streamed a page at a time (audit D5), so the Worker never holds
// a whole table; each stops at EXPORT_MAX_ROWS, and the tables cut short are
// listed under `truncated`.
const EXPORT_PAGE = 500;
export const EXPORT_MAX_ROWS = 250_000;

account.get("/export", (c) => {
  const d = c.var.data;
  const { account: a } = c.var.session;
  type Table = Parameters<typeof d.page>[0];
  const tables: [string, Table, (row: never) => unknown][] = [
    [
      "providerKeys",
      "providerKeys",
      (k: { provider: string; last4: string; checkStatus: unknown; createdAt: Date }) => ({
        provider: k.provider,
        last4: k.last4,
        checkStatus: k.checkStatus,
        createdAt: k.createdAt,
      }),
    ],
    [
      "sessions",
      "sessions",
      (s: {
        kind: string;
        label: string | null;
        createdAt: Date;
        lastUsedAt: Date | null;
        expiresAt: Date;
        refreshExpiresAt: Date | null;
      }) => ({
        kind: s.kind,
        label: s.label,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.refreshExpiresAt ?? s.expiresAt,
      }),
    ],
    ["preferences", "preferences", strip],
    ["reviews", "reviews", strip],
    ["gatewayCalls", "gatewayCalls", strip],
    ["auditEvents", "auditEvents", strip],
    ["findings", "findings", strip],
    ["memory", "accountMemory", strip],
  ];
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(out) {
      const put = (text: string) => out.enqueue(enc.encode(text));
      try {
        put(`{"exportedAt":${JSON.stringify(new Date())}`);
        put(
          `,"account":${JSON.stringify({ login: a.login, githubId: a.githubId, createdAt: a.createdAt })}`,
        );
        const truncated: string[] = [];
        for (const [key, table, shape] of tables) {
          put(`,${JSON.stringify(key)}:[`);
          let after = 0;
          let written = 0;
          for (;;) {
            const page = await d.page(table, after, EXPORT_PAGE);
            for (const row of page.rows) {
              if (written >= EXPORT_MAX_ROWS) break;
              put(`${written > 0 ? "," : ""}${JSON.stringify(shape(row as never))}`);
              written++;
            }
            if (page.next === null) break;
            if (written >= EXPORT_MAX_ROWS) {
              truncated.push(key);
              break;
            }
            after = page.next;
          }
          put("]");
        }
        if (truncated.length > 0) put(`,"truncated":${JSON.stringify(truncated)}`);
        put("}");
        out.close();
      } catch (e) {
        out.error(e);
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="ocra-cloud-export.json"',
    },
  });
});

function strip<T extends { accountId: string }>({ accountId: _a, ...r }: T) {
  return r;
}

account.delete("/account", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== c.var.session.account.login) {
    return c.json({ error: "confirm_with_login" }, 400);
  }
  await deleteAccount(c.var.db, c.var.session.account.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ deleted: true });
});

// Sharing findings (ADR-0028, 2): off by default. Turning it off can delete
// every finding sent; the counts stay.
account.get("/account/sharing", async (c) => {
  const stored = await c.var.data.countAll("findings");
  return c.json({ shareFindings: c.var.session.account.shareFindings, findingsStored: stored });
});

account.put("/account/sharing", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: unknown;
    deleteExisting?: unknown;
  } | null;
  if (typeof body?.enabled !== "boolean") return c.json({ error: "bad_request" }, 400);
  await setSharing(c.var.db, c.var.session.account.id, body.enabled);
  const deleted =
    !body.enabled && body.deleteExisting === true ? await c.var.data.removeAll("findings") : 0;
  await audit(c.var.data, "sharing.changed", { shareFindings: body.enabled, deleted });
  return c.json({ shareFindings: body.enabled, deleted });
});

// The account's repository-hash salt, so one repository hashes alike on all
// its machines; only while findings are shared (ADR-0028, 4).
account.get("/account/salt", async (c) => {
  if (!c.var.session.account.shareFindings) return c.json({ salt: null });
  return c.json({ salt: await accountSalt(c.var.db, c.var.session.account.id) });
});
