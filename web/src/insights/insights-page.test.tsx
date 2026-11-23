import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { Insights } from "../pages/Insights.js";

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
            bySeverity: [row("warning", 0, 0, 0)],
            byCategory: [],
            byVerification: [],
            byRule: [
              { ...row("rule:no-raw-sql", 0, 0, 0), rule: { kind: "rule", id: "no-raw-sql" } },
              { ...row(null, 0, 0, 0), rule: null },
            ],
            otherRules: { ...total, rules: 2 },
            dismissReasons: [],
          });
        }
        if (url.startsWith("/api/reviews")) {
          return Response.json({ days: 30, summary, spend: [], reviewers: {}, reviews: [] });
        }
        return Response.json({ error: "internal" }, { status: 500 });
      }),
    );
    render(<Insights runner={false} platforms={["github"]} />);
    const security = await screen.findByRole("row", { name: /^security/ });
    expect(within(security).getByText("75% of 4")).toBeTruthy();
    expect(within(security).getByText("25% of 4")).toBeTruthy();
    const tests = screen.getByRole("row", { name: /^tests/ });
    expect(within(tests).getAllByText("–")).toHaveLength(2);
    expect(screen.getByText(/· 75% upvoted/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /^Warning/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /^no-raw-sql \(rule\)/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /^No rule named/ })).toBeTruthy();
    expect(screen.getByText("And 2 more rules, with 10 findings: 67% accepted.")).toBeTruthy();
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
            byRule: [],
            otherRules: null,
            dismissReasons: [],
          });
        }
        if (url.startsWith("/api/reviews")) {
          return Response.json({ days: 30, summary, spend: [], reviewers: {}, reviews: [] });
        }
        return Response.json({ error: "internal" }, { status: 500 });
      }),
    );
    render(<Insights runner={false} platforms={["github"]} />);
    await screen.findByRole("row", { name: /^security/ });
    const text = document.body.textContent ?? "";
    expect(text).toContain("The tables count the 8 of the 17 findings that were shared");
    expect(text).toContain("1 fixed on a later review");
    expect(text).not.toContain("1 finding fixed");
  });

  it("gives as Spend all the account spent in the period, and says what that counts", async () => {
    const summary = {
      reviews: 2,
      repositories: 1,
      findings: 0,
      critical: 0,
      blocking: 0,
      incomplete: 0,
      fixed: 0,
      dismissed: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.4,
    };
    const spend = [
      { day: "2026-11-20", usd: 1.15 },
      { day: "2026-11-21", usd: 2.35 },
    ];
    const none = { total: 0, open: 0, fixed: 0, dismissed: 0, reacted: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/findings/insights")) {
          return Response.json({
            days: 30,
            total: { ...none, acceptanceRate: null, thumbsUpRate: null, downvoteRate: null },
            byReviewer: [],
            bySeverity: [],
            byCategory: [],
            byVerification: [],
            byRule: [],
            otherRules: null,
            dismissReasons: [],
          });
        }
        if (url.startsWith("/api/reviews")) {
          return Response.json({ days: 30, summary, spend, reviewers: {}, reviews: [] });
        }
        return Response.json({ error: "internal" }, { status: 500 });
      }),
    );
    render(<Insights runner={false} platforms={["github"]} />);
    const stat = await screen.findByRole("link", { name: /^Spend/ });
    expect(stat?.textContent).toContain("$3.50");
    expect(stat?.textContent).toContain("$0.20 a review");
    expect(
      screen.getByText(/^Spend is the cost reviews uploaded to ocra Cloud reported/),
    ).toBeTruthy();
  });
});
