import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewLoadView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { ReviewLoadSection } from "./reviewers.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const HOUR = 3_600_000;
const none = { median: null, p90: null, count: 0 };
const view = (over: Partial<ReviewLoadView> = {}): ReviewLoadView => ({
  repo: null,
  days: 30,
  reviewers: [],
  weeks: [{ start: "2026-11-16", turnaround: none, waitingOver24h: 0 }],
  capped: false,
  ...over,
});
const serve = (v: ReviewLoadView) => {
  const fetch = vi.fn(async () => Response.json(v));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("the reviewer workload on Insights", () => {
  it("shows each week's turnaround and who waited, and each reviewer's load", async () => {
    const fetch = serve(
      view({
        weeks: [
          {
            start: "2026-11-09",
            turnaround: { median: 3 * HOUR, p90: 30 * HOUR, count: 5 },
            waitingOver24h: 2,
          },
          { start: "2026-11-16", turnaround: none, waitingOver24h: 0 },
        ],
        reviewers: [
          {
            login: "ada",
            reviews: 7,
            asked: 9,
            toFirstReview: { median: 2 * HOUR, p90: 20 * HOUR, count: 6 },
            openRequests: 3,
            authored: 1,
          },
          {
            login: "lin",
            reviews: 0,
            asked: 1,
            toFirstReview: none,
            openRequests: 0,
            authored: 4,
          },
        ],
      }),
    );
    render(<ReviewLoadSection days={30} />);
    const section = await screen.findByRole("region", { name: "Reviewer workload" });
    expect(fetch).toHaveBeenCalledWith("/api/insights/reviewers?days=30", expect.anything());
    const weeks = within(section).getAllByRole("listitem");
    expect(weeks[0]?.textContent).toMatch(/3\.0h median · p90 30h · 5 reviews/);
    expect(weeks[0]?.textContent).toMatch(/2 waited over a day/);
    expect(weeks[1]?.textContent).toMatch(/No reviews/);
    const median = weeks[0]?.querySelector<HTMLElement>(".median");
    expect(median?.style.width).toBe("10%");
    const [, ada, lin] = within(section).getAllByRole("row");
    expect(
      within(ada as HTMLElement)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["ada", "7", "9", "2.0h · p90 20h", "3", "1"]);
    expect(within(lin as HTMLElement).getAllByRole("cell")[3]?.textContent).toBe("–");
  });

  it("says nothing is recorded yet instead of an empty table", async () => {
    serve(view());
    render(<ReviewLoadSection days={7} />);
    expect(await screen.findByText(/Nothing recorded in this period/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
