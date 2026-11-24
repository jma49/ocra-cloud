import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { Insights } from "../pages/Insights.js";

// The charts load a library this test environment cannot; its tables are what is read here.
vi.mock("./charts.js", () => ({ default: () => null }));

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

describe("Insights", () => {
  const show = (runner: boolean, platforms: ("github" | "gitlab")[] = ["github"]) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "internal" }, { status: 500 })),
    );
    render(<Insights runner={runner} platforms={platforms} />);
  };

  it("leaves out the review flow and workload where the server reviews no repository itself", async () => {
    show(false);
    expect(await screen.findByRole("region", { name: "Pull request cycle" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Review flow" })).toBeNull();
    expect(screen.getByRole("region", { name: "What ocra changed" })).toBeTruthy();
  });

  it("shows them where it does", async () => {
    show(true);
    expect(await screen.findByRole("region", { name: "Review flow" })).toBeTruthy();
  });

  it("offers the cycle's platforms only where the server has more than one", async () => {
    show(false);
    const cycle = await screen.findByRole("region", { name: "Pull request cycle" });
    expect(within(cycle).queryByRole("group", { name: "Platform" })).toBeNull();
    cleanup();
    show(false, ["github", "gitlab"]);
    const both = await screen.findByRole("region", { name: "Pull request cycle" });
    expect(within(both).getByRole("group", { name: "Platform" })).toBeTruthy();
  });

  it("gives each reviewer's share of upvoted and downvoted findings among those reacted to", async () => {
    const row = (key: string | null, up: number, down: number, reacted: number) => ({
      key,
      total: 10,
      open: 4,
      fixed: 4,
      dismissed: 2,
      addressed: 0,
      merged: 0,
      accepted: 5,
      thumbsUp: up,
      thumbsDown: down,
      reacted,
      acceptanceRate: 4 / 6,
      thumbsUpRate: reacted ? up / reacted : null,
      downvoteRate: reacted ? down / reacted : null,
    });
    const { key: _, ...total } = row(null, 3, 1, 4);
    const summary = {
      reviews: 2,
      repositories: 1,
      findings: 10,
      critical: 0,
      blocking: 0,
      incomplete: 0,
      fixed: 4,
      dismissed: 2,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.4,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/findings/insights")) {
          return Response.json({
            days: 30,
            total,
            byReviewer: [row("security", 3, 1, 4), row("tests", 0, 0, 0)],
            bySeverity: [],
            byCategory: [],
            byVerification: [],
            dismissReasons: [],
          });
        }
        if (url.startsWith("/api/reviews")) {
          return Response.json({ days: 30, summary, reviewers: {}, reviews: [] });
        }
        return Response.json({ error: "internal" }, { status: 500 });
      }),
    );
    Object.defineProperty(document, "fonts", {
      value: { ready: Promise.resolve() },
      configurable: true,
    });
    render(<Insights runner={false} platforms={["github"]} />);
    const security = await screen.findByRole("row", { name: /^security/ });
    expect(within(security).getByText("75% of 4")).toBeTruthy();
    expect(within(security).getByText("25% of 4")).toBeTruthy();
    const tests = screen.getByRole("row", { name: /^tests/ });
    expect(within(tests).getAllByText("–")).toHaveLength(2);
    expect(screen.getByText(/· 75% upvoted/)).toBeTruthy();
  });
});
