import { describe, expect, it } from "vitest";
import type { Review } from "../api.js";
import { acceptanceChart, daily, flat, quantile } from "./series.js";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 21, 15);
const review = (daysAgo: number, over: Partial<Review> = {}): Review =>
  ({
    createdAt: new Date(now - daysAgo * DAY).toISOString(),
    critical: 0,
    warning: 0,
    suggestion: 0,
    costUsd: 0,
    durationMs: 0,
    ...over,
  }) as Review;

describe("the insights series", () => {
  it("take the nearest-rank quantile", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it("sum each day's findings and spend, oldest day first, and leave out what is older", () => {
    const d = daily(
      [
        review(0, { critical: 1, warning: 2, costUsd: 0.125 }),
        review(0, { critical: 1, costUsd: 0.2 }),
        review(2, { suggestion: 3 }),
        review(9, { critical: 5 }),
      ],
      3,
      now,
    );
    expect(d.critical.map((p) => p.value)).toEqual([0, 0, 2]);
    expect(d.suggestion.map((p) => p.value)).toEqual([3, 0, 0]);
    expect(d.spend.at(-1)?.value).toBe(0.33);
    expect(d.critical[0]?.start.toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("give review time only on days that had reviews", () => {
    const d = daily(
      [
        review(0, { durationMs: 30_000 }),
        review(0, { durationMs: 90_000 }),
        review(1, { durationMs: 60_000 }),
      ],
      3,
      now,
    );
    expect(d.p50.map((p) => p.value)).toEqual([60, 30]);
    expect(d.p95.map((p) => p.value)).toEqual([60, 90]);
  });

  it("say when a series has nothing to draw", () => {
    const quiet = daily([review(0, { costUsd: 0 })], 3, now);
    expect(flat(quiet.spend)).toBe(true);
    expect(flat(daily([review(0, { costUsd: 0.2 })], 3, now).spend)).toBe(false);
  });
});

describe("acceptance chart", () => {
  it("says how many were decided while too few were to compare rates", () => {
    expect(acceptanceChart([{ reviewer: "correctness", rate: 1, decided: 1 }])).toEqual({
      decided: 1,
    });
  });

  it("charts the reviewers with decided findings once there are enough", () => {
    const rows = [
      { reviewer: "correctness", rate: 0.75, decided: 4 },
      { reviewer: "security", rate: 1, decided: 2 },
      { reviewer: "style", rate: 0, decided: 0 },
    ];
    expect(acceptanceChart(rows)).toEqual({ bars: rows.slice(0, 2) });
  });
});
