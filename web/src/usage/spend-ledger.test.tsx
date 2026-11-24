import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ledger, LedgerRow } from "../api.js";
import { clearCache } from "../cache.js";
import { SpendLedger } from "./spend-ledger.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const row = (r: Partial<LedgerRow>): LedgerRow => ({
  day: "2026-11-23",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  calls: 1,
  failed: 0,
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  costUsd: 0,
  unpriced: 0,
  ...r,
});

function serve(ledgers: Record<string, Ledger>) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const month = new URL(url, "https://ocra.test").searchParams.get("month") ?? "2026-11";
      const ledger = ledgers[month];
      return ledger
        ? Response.json(ledger)
        : Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return asked;
}

describe("Spend by day", () => {
  it("lists each day's models with what they cost, the unpriced calls apart, and the month's total", async () => {
    serve({
      "2026-11": {
        month: "2026-11",
        months: ["2026-11", "2026-10"],
        rows: [
          row({ calls: 3, input: 1_200, cacheWrite5m: 300, cacheWrite1h: 200, costUsd: 1.5 }),
          row({ model: "vendor/other", provider: "openrouter", calls: 2, unpriced: 2 }),
          row({ day: "2026-11-24", calls: 2, unpriced: 1, costUsd: 0.25 }),
        ],
      },
    });
    render(<SpendLedger />);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]?.textContent).toContain("500");
    expect(rows[1]?.textContent).toContain("$1.50");
    expect(rows[2]?.textContent).toContain("Unpriced");
    expect(rows[3]?.textContent).toContain("$0.25 + 1 call unpriced");
    expect(rows.at(-1)?.textContent).toContain("Total");
    expect(rows.at(-1)?.textContent).toContain("$1.75 + 3 calls unpriced");
    const csv = screen.getByRole("link", { name: "CSV" });
    expect(csv.getAttribute("href")).toBe("/api/ledger/csv?month=2026-11");
  });

  it("shows another kept month when it is picked", async () => {
    const asked = serve({
      "2026-11": { month: "2026-11", months: ["2026-11", "2026-10"], rows: [] },
      "2026-10": { month: "2026-10", months: ["2026-11", "2026-10"], rows: [] },
    });
    render(<SpendLedger />);
    expect(await screen.findByText("No model calls in Nov 2026")).toBeTruthy();
    screen.getByRole("button", { name: "Oct 2026" }).click();
    expect(await screen.findByText("No model calls in Oct 2026")).toBeTruthy();
    expect(asked.at(-1)).toBe("/api/ledger?month=2026-10");
    expect(screen.getByRole("link", { name: "CSV" }).getAttribute("href")).toBe(
      "/api/ledger/csv?month=2026-10",
    );
  });
});
