import upload from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewTraceView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { ReviewDetail } from "../pages/ReviewDetail.js";
import { funnel, modelLabel, place, rows, secs, summary, ticks } from "./model.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

// The engine's sample trace (packages/cloud-contract/fixtures/upload.json).
const trace = upload.trace as ReviewTraceView;

describe("the trace's model", () => {
  it("lays tasks by start, then the model calls, each attempt a span", () => {
    const laid = rows(trace);
    expect(laid.map((r) => r.kind)).toEqual([
      "task",
      "task",
      "task",
      "call",
      "call",
      "call",
      "call",
    ]);
    const huge = laid.find((r) => r.kind === "task" && r.task.id === "logic-2");
    expect(huge?.spans.map((s) => s.tone)).toEqual(["failed", "partial"]);
  });

  it("reads durations, models, ticks and the findings' funnel in words", () => {
    expect([secs(320), secs(4_210), secs(65_000)]).toEqual(["320 ms", "4.2 s", "1m 05s"]);
    expect(modelLabel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(modelLabel("ocra-openrouter/qwen/qwen3")).toBe("qwen/qwen3");
    expect(ticks(61_234)).toEqual({ stepMs: 15_000, at: [0, 15_000, 30_000, 45_000, 60_000] });
    expect(place(59_000, 5_000, 60_000)).toEqual({ x: 59_000 / 60_000, w: 1 - 59_000 / 60_000 });
    expect(funnel(trace.findings)).toBe(
      "5 reported · 2 kept · 1 refuted by Verify · 1 dropped by the judge · 1 outside the review",
    );
    expect(summary(trace)).toBe("1m 01s · 3 tasks · 4 model calls · $0.56");
  });
});

function serve(traced: boolean) {
  const detail = {
    review: {
      id: "r1",
      runId: "run-2026-10-04-a1b2",
      repo: "abcd1234",
      source: "local",
      verdict: "minor_issues",
      complete: true,
      critical: 1,
      warning: 1,
      suggestion: 0,
      createdAt: new Date().toISOString(),
      prRepository: null,
      prNumber: null,
      learnings: null,
    },
    findings: [],
    walkthrough: null,
    traced,
  };
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/reviews/r1") return Response.json(detail);
    if (url === "/api/reviews/r1/trace") return Response.json({ trace });
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("a review's trace on its page", () => {
  it("is asked for only when the review kept one", async () => {
    const fetch = serve(false);
    render(<ReviewDetail id="r1" graphs={false} />);
    await screen.findByRole("complementary", { name: "Properties" });
    expect(screen.queryByRole("heading", { name: "Trace" })).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain("/api/reviews/r1/trace");
  });

  it("shows the run's rows, opens one, and lists each finding's fate and reason", async () => {
    serve(true);
    render(<ReviewDetail id="r1" graphs={false} />);
    await screen.findByRole("heading", { name: "Trace" });
    expect(
      screen.getByText("1m 01s · 3 tasks · 4 model calls · $0.56 · secrets redacted"),
    ).toBeTruthy();
    const timeline = screen.getByRole("region", { name: "Timeline" });
    expect(within(timeline).getAllByText("Judge")).toHaveLength(2);
    expect(within(timeline).getByText("Plan for Logic")).toBeTruthy();

    const huge = within(timeline)
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("huge.ts"));
    expect(huge?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(huge as HTMLElement);
    expect(huge?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Attempt 2 · gpt-5\.2/)).toBeTruthy();
    expect(screen.getByText(/Used every step/)).toBeTruthy();
    expect(screen.getAllByText("2 searches, literals not kept").length).toBeGreaterThan(0);

    const findings = screen.getByRole("region", { name: "Findings" });
    expect(within(findings).getByText("Refuted by Verify")).toBeTruthy();
    expect(
      within(findings).getByText(
        "query() reads the timeout from the pool's options, set in src/db.ts.",
      ),
    ).toBeTruthy();
    expect(within(findings).getByText(/The judge made it warning, from critical/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download trace" })).toBeTruthy();
  });
});
