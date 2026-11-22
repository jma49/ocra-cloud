import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InsightsFlowView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { FlowSection } from "./flow.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const HOUR = 3_600_000;
const none = { median: null, p90: null, count: 0 };
const flow = (over: Partial<InsightsFlowView> = {}): InsightsFlowView => ({
  repo: null,
  days: 30,
  weeks: [{ start: "2026-11-16T00:00:00.000Z", opened: 0, merged: 0 }],
  toFirstReview: none,
  toFirstApproval: none,
  approvalToMerge: none,
  waiting: [],
  reviewers: [],
  sizes: { xs: 0, s: 0, m: 0, l: 0, xl: 0, unknown: 0 },
  capped: false,
  ...over,
});

function serve(view: InsightsFlowView) {
  const fetch = vi.fn(async () => Response.json(view));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("the review flow on Insights", () => {
  it("shows the spreads, the weeks, the sizes that have pull requests, who waits and who reviews", async () => {
    const fetch = serve(
      flow({
        weeks: [
          { start: "2026-11-09T00:00:00.000Z", opened: 6, merged: 4 },
          { start: "2026-11-16T00:00:00.000Z", opened: 3, merged: 5 },
        ],
        toFirstReview: { median: 2 * HOUR, p90: 20 * HOUR, count: 8 },
        toFirstApproval: { median: 5 * HOUR, p90: 30 * HOUR, count: 7 },
        approvalToMerge: { median: 30 * 60_000, p90: 3 * HOUR, count: 1 },
        waiting: [
          {
            repo: "acme/payments",
            number: 491,
            title: "Retry the ledger post",
            author: "ada",
            waitingMs: 72 * HOUR,
            reviewRequested: false,
          },
        ],
        reviewers: [{ login: "grace", reviews: 12, approvals: 7, pulls: 9 }],
        sizes: { xs: 2, s: 5, m: 2, l: 0, xl: 0, unknown: 0 },
        capped: true,
      }),
    );
    render(<FlowSection days={30} />);
    const section = await screen.findByRole("region", { name: "Review flow" });
    expect(await within(section).findByText("2.0h")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/insights/flow?days=30", expect.anything());
    expect(within(section).getByText(/p90 20h · 8 pull requests/)).toBeTruthy();
    expect(within(section).getByText(/p90 3\.0h · 1 pull request$/)).toBeTruthy();
    expect(within(section).getByText("Under 100")).toBeTruthy();
    expect(within(section).queryByText("Under 1,000")).toBeNull();
    expect(within(section).getByText("Retry the ledger post")).toBeTruthy();
    expect(within(section).getByText(/acme\/payments #491 · no reviewer asked/)).toBeTruthy();
    expect(within(section).getByText("3.0d")).toBeTruthy();
    expect(within(section).getByText("grace")).toBeTruthy();
    expect(within(section).getByText(/these are the newest/)).toBeTruthy();
  });

  it("says what it counts when nothing was recorded", async () => {
    serve(flow());
    render(<FlowSection days={7} />);
    expect(await screen.findByText(/Nothing recorded in this period/)).toBeTruthy();
    expect(screen.queryByText("To first review")).toBeNull();
  });
});
