import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FindingInsightsView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { Findings } from "../pages/Findings.js";
import { Insights } from "../pages/Insights.js";

// A number on Insights opens the list it counts, filtered as it counted.

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  await clearCache();
});

const zero = {
  total: 0,
  open: 0,
  fixed: 0,
  dismissed: 0,
  addressed: 0,
  merged: 0,
  accepted: 0,
  thumbsUp: 0,
  thumbsDown: 0,
  reacted: 0,
  acceptanceRate: null,
  thumbsUpRate: null,
  downvoteRate: null,
};
const summary = {
  reviews: 2,
  repositories: 1,
  findings: 5,
  critical: 1,
  blocking: 1,
  incomplete: 0,
  fixed: 0,
  dismissed: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0.4,
};

function serve(seen: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/^\/api/, "");
      seen.push(path);
      if (path.startsWith("/findings/insights"))
        return Response.json({
          days: 7,
          total: zero,
          byReviewer: [],
          bySeverity: [],
          byCategory: [],
          byVerification: [],
          byRule: [],
          otherRules: null,
          dismissReasons: [],
        } satisfies FindingInsightsView);
      if (path.startsWith("/reviews"))
        return Response.json({ days: 7, summary, spend: [], reviewers: {}, reviews: [] });
      if (path.startsWith("/findings"))
        return Response.json({
          findings: [],
          next: null,
          statuses: { open: 0, fixed: 0, dismissed: 0 },
        });
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return seen;
}

describe("Insights' numbers", () => {
  it("link to the reviews of the period and the findings they count", async () => {
    serve();
    render(<Insights runner={false} platforms={["github"]} />);
    const critical = await screen.findByRole("link", { name: /^Critical/ });
    expect(critical.getAttribute("href")).toBe("/findings?status=all&severity=critical");
    expect(screen.getByRole("link", { name: /^Reviews/ }).getAttribute("href")).toBe(
      "/reviews?days=30",
    );
  });

  it("open Findings filtered as the link asked", async () => {
    const seen = serve();
    history.replaceState(null, "", "/findings?status=all&severity=critical");
    render(<Findings />);
    await screen.findByRole("heading", { level: 1 });
    await vi.waitFor(() => expect(seen).toContain("/findings?severity=critical"));
  });
});
