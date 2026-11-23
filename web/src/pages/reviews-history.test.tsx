import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Review } from "../api.js";
import { Reviews } from "./Reviews.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const review = (over: Partial<Review>): Review => ({
  id: "r1",
  runId: "run",
  repo: "abc12345",
  source: "github",
  tier: null,
  verdict: "approved",
  complete: true,
  findings: 0,
  critical: 0,
  warning: 0,
  suggestion: 0,
  filesReviewed: 1,
  filesNotReviewed: 0,
  tasksCompleted: 1,
  tasksFailed: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  durationMs: 1000,
  ocraVersion: null,
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

it("names each review by what it was of, and links it to the review", async () => {
  const reviews = [
    review({ name: "octo/api", prNumber: 7, prHeadSha: "abcdef0123456789" }),
    review({ id: "r2", source: "local" }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ days: 30, summary: {}, reviewers: {}, reviews })),
  );
  render(<Reviews />);
  const ofPull = await screen.findByRole("link", { name: "octo/api #7" });
  expect(ofPull.getAttribute("href")).toBe("/reviews/r1");
  expect(ofPull.closest(".review-of")?.textContent).toContain("abcdef0");
  const local = screen.getByRole("link", { name: "abc12345" });
  expect(local.getAttribute("href")).toBe("/reviews/r2");
  expect(local.closest(".review-of")?.textContent).not.toContain("#");
});
