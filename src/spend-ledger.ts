import { type Context, Hono } from "hono";
import { config } from "./config.js";
import type { LedgerRow } from "./db/ledger.js";
import { apiError } from "./http.js";
import { requireSession } from "./session.js";
import { DAY, utcMonth } from "./time.js";
import type { AppEnv } from "./types.js";

// What the account's model calls used and cost in a calendar month, by UTC
// day and model: to read on the Usage page, and as a CSV to set beside the
// provider's own usage export (scripts/reconcile-usage.ts).

export const ledgerRoute = new Hono<AppEnv>().use(requireSession(["web"]));

/** The months whose calls are still kept, newest first, ending with now's. */
function keptMonths(now: Date, retentionDays: number): string[] {
  const oldest = new Date(now.getTime() - retentionDays * DAY);
  const months: string[] = [];
  for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); ; ) {
    months.push(d.toISOString().slice(0, 7));
    if (d <= oldest) return months;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  }
}

/** The month the query names, or now's; undefined when it names one not kept. */
async function monthOf(c: Context<AppEnv>) {
  const now = new Date();
  const months = keptMonths(now, config(c.env).retentionDays);
  const month = c.req.query("month") ?? months[0] ?? "";
  const bounds = months.includes(month) ? utcMonth(month) : null;
  if (!bounds) return undefined;
  return { month, months, rows: await c.var.data.ledger(bounds.from, bounds.to) };
}

ledgerRoute.get("/", async (c) => {
  const found = await monthOf(c);
  if (!found) return apiError(c, "not_found");
  return c.json(found);
});

const COLUMNS = [
  "usage_date_utc",
  "provider",
  "model",
  "calls",
  "failed_calls",
  "input_tokens_no_cache",
  "input_tokens_cache_write_5m",
  "input_tokens_cache_write_1h",
  "input_tokens_cache_read",
  "output_tokens",
  "cost_usd",
  "unpriced_calls",
] as const;

/**
 * A field as a spreadsheet reads it safely: quoted when it holds a quote, a
 * comma or a line break, and a model name that would start a formula kept
 * as text. Model names are whatever a caller sent.
 */
function field(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvLine(r: LedgerRow): string {
  return [
    r.day,
    r.provider,
    r.model,
    r.calls,
    r.failed,
    r.input,
    r.cacheWrite5m,
    r.cacheWrite1h,
    r.cacheRead,
    r.output,
    r.costUsd.toFixed(6),
    r.unpriced,
  ]
    .map(field)
    .join(",");
}

ledgerRoute.get("/csv", async (c) => {
  const found = await monthOf(c);
  if (!found) return apiError(c, "not_found");
  const body = [COLUMNS.join(","), ...found.rows.map(csvLine)].join("\r\n");
  return c.body(`${body}\r\n`, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="ocra-usage-${found.month}.csv"`,
    "cache-control": "no-store",
  });
});
