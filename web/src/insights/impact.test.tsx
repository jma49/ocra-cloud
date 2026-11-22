import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImpactCounts, InsightsImpactView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { ImpactSection } from "./impact.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const HOUR = 3_600_000;
const none = { median: null, p90: null, count: 0 };
const counts = (over: Partial<ImpactCounts> = {}): ImpactCounts => ({
  pulls: 0,
  reviewedPulls: 0,
  reviews: 0,
  findings: { critical: 0, warning: 0, suggestion: 0 },
  fixedOnRereview: 0,
  dismissedOnRereview: 0,
  actedOn: null,
  ...over,
});
const impact = (over: Partial<InsightsImpactView> = {}): InsightsImpactView => ({
  repo: null,
  days: 30,
  sharesFindings: false,
  total: counts(),
  weeks: [{ start: "2026-11-16T00:00:00.000Z", ...counts() }],
  repos: [],
  toMerge: { fromReview: none, reviewed: none, unreviewed: none },
  capped: false,
  ...over,
});

function serve(view: InsightsImpactView) {
  const fetch = vi.fn(async () => Response.json(view));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const busy = counts({
  pulls: 20,
  reviewedPulls: 15,
  reviews: 31,
  findings: { critical: 2, warning: 9, suggestion: 14 },
  fixedOnRereview: 11,
  dismissedOnRereview: 3,
  actedOn: { fixed: 6, dismissed: 4, open: 15, issueOpened: 1 },
});

describe("what ocra changed on Insights", () => {
  it("shows the reviewed share, the findings and what became of them, and compares the merge times", async () => {
    const fetch = serve(
      impact({
        sharesFindings: true,
        total: busy,
        weeks: [{ start: "2026-11-16T00:00:00.000Z", ...busy }],
        repos: [
          { repo: "acme/payments", ...busy },
          { repo: "acme/ledger", ...counts({ pulls: 4, reviewedPulls: 1 }) },
        ],
        toMerge: {
          fromReview: { median: 3 * HOUR, p90: 20 * HOUR, count: 12 },
          reviewed: { median: 5 * HOUR, p90: 30 * HOUR, count: 12 },
          unreviewed: { median: 9 * HOUR, p90: 40 * HOUR, count: 4 },
        },
      }),
    );
    render(<ImpactSection days={30} />);
    const section = await screen.findByRole("region", { name: "What ocra changed" });
    expect(await within(section).findAllByText("75%")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith("/api/insights/impact?days=30", expect.anything());
    expect(within(section).getByText("15 of 20 opened · 31 reviews")).toBeTruthy();
    expect(within(section).getByText("2 critical · 9 warning")).toBeTruthy();
    expect(within(section).getByText(/3 dismissed by a reviewer/)).toBeTruthy();
    expect(within(section).getByText("Opened to merge, not reviewed")).toBeTruthy();
    expect(within(section).getByText("9.0h")).toBeTruthy();
    expect(
      within(section).getByText(/6 marked fixed, 4 dismissed, 15 open, 1 issue opened/),
    ).toBeTruthy();
    expect(within(section).getByText("acme/ledger")).toBeTruthy();
    expect(within(section).getByText("25%")).toBeTruthy();
  });

  it("leaves the merge comparison out without both kinds, and says why the console's counts are missing", async () => {
    serve(
      impact({
        total: counts({ pulls: 3, reviewedPulls: 3, reviews: 3 }),
        toMerge: {
          fromReview: { median: HOUR, p90: HOUR, count: 2 },
          reviewed: { median: HOUR, p90: HOUR, count: 2 },
          unreviewed: none,
        },
      }),
    );
    render(<ImpactSection days={30} />);
    expect(await screen.findByText("100%")).toBeTruthy();
    expect(screen.queryByText("Opened to merge, reviewed by ocra")).toBeNull();
    expect(screen.queryByText("Findings, by severity")).toBeNull();
    expect(screen.getByText(/Share findings in Settings/)).toBeTruthy();
  });

  it("says what it counts when nothing was recorded", async () => {
    serve(impact());
    render(<ImpactSection days={7} />);
    expect(await screen.findByText(/Nothing recorded in this period/)).toBeTruthy();
    expect(screen.queryByText("Pull requests reviewed")).toBeNull();
  });
});
