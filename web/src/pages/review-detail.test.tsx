import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { ReviewDetail } from "./ReviewDetail.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const review = (learnings: string[] | null) => ({
  review: {
    id: "r1",
    runId: "run",
    repo: "abcd1234",
    source: "local",
    verdict: "approve",
    complete: true,
    critical: 0,
    warning: 0,
    suggestion: 0,
    createdAt: new Date().toISOString(),
    prRepository: null,
    prNumber: null,
    learnings,
  },
  findings: [],
  walkthrough: null,
});

function serve(learnings: string[] | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/reviews/r1"
        ? Response.json(review(learnings))
        : Response.json({ error: "not_found" }, { status: 404 }),
    ),
  );
}

describe("a review's properties", () => {
  it("name the learnings its reviewers were given", async () => {
    serve(["refund-cap", "ledger-order"]);
    render(<ReviewDetail id="r1" graphs={false} />);
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(within(props).getByText("Learnings")).toBeTruthy();
    expect(within(props).getByText("refund-cap")).toBeTruthy();
    expect(within(props).getByText("ledger-order")).toBeTruthy();
  });

  it("leave learnings out when the review was given none", async () => {
    serve([]);
    render(<ReviewDetail id="r1" graphs={false} />);
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(within(props).queryByText("Learnings")).toBeNull();
  });
});
