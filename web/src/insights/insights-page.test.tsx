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
    const gateway = { costUsd: 0.15, calls: 3, console: 3, unpriced: 2, days: [] };
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
            bySeverity: [row("warning", 0, 0, 0)],
            byCategory: [],
            byVerification: [],
            dismissReasons: [],
          });
        }
        if (url.startsWith("/api/reviews")) {
          return Response.json({ days: 30, summary, reviewers: {}, reviews: [], gateway });
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
    expect(screen.getByRole("row", { name: /^Warning/ })).toBeTruthy();
    // The reviews' $0.40 and ocra Cloud's own calls' $0.15, and what it leaves out.
    expect(screen.getByText("$0.55")).toBeTruthy();
    expect(
      screen.getByText("$0.20 a review · $0.15 in ocra actions · 2 calls unpriced"),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("Runs outside Cloud (CI, local) are not included");
  });

  it("says which findings the tables count where the reviews reported more than were shared", async () => {
    // Seen live: 17 findings reported, 8 shared; 1 fixed on a later review, 2 marked fixed.
    const tally = {
      total: 8,
      open: 6,
      fixed: 2,
      dismissed: 0,
      addressed: 0,
      merged: 0,
      accepted: 2,
      thumbsUp: 0,
      thumbsDown: 0,
      reacted: 0,
      acceptanceRate: 1,
      thumbsUpRate: null,
      downvoteRate: null,
    };
    const gateway = { costUsd: 0, calls: 0, console: 0, unpriced: 0, days: [] };
    const summary = {
      reviews: 4,
      repositories: 1,
      findings: 17,
      critical: 1,
      blocking: 0,
      incomplete: 0,
      fixed: 1,
      dismissed: 0,
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
            total: tally,
            byReviewer: [{ key: "security", ...tally }],
            bySeverity: [],
            byCategory: [],
            byVerification: [],
            dismissReasons: [],
          });
        }
        if (url.startsWith("/api/reviews")) {
          return Response.json({ days: 30, summary, reviewers: {}, reviews: [], gateway });
        }
        return Response.json({ error: "internal" }, { status: 500 });
      }),
    );
    Object.defineProperty(document, "fonts", {
      value: { ready: Promise.resolve() },
      configurable: true,
    });
    render(<Insights runner={false} platforms={["github"]} />);
    await screen.findByRole("row", { name: /^security/ });
    const text = document.body.textContent ?? "";
    expect(text).toContain("The tables count the 8 of the 17 findings that were shared");
    expect(text).toContain("1 fixed on a later review");
    expect(text).not.toContain("1 finding fixed");
  });
});
