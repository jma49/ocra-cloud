import { describe, expect, it } from "vitest";
import { ago, count, elapsed, period, since, time } from "./format.js";

describe("how counts and times read", () => {
  it("counts work under way in seconds, then minutes", () => {
    expect(elapsed(-400)).toBe("0s");
    expect(elapsed(59_900)).toBe("59s");
    expect(elapsed(125_000)).toBe("2m 05s");
  });

  it("reads a time of day without a leading zero on the hour", () => {
    const at = new Date(2026, 0, 5, 4, 5).toISOString();
    expect(time(at)).toMatch(/\b4:05/);
    expect(time(at)).not.toMatch(/\b04:05/);
  });

  it("puts a count's noun in the right number", () => {
    expect(count(1, "repository", "repositories")).toBe("1 repository");
    expect(count(2, "repository", "repositories")).toBe("2 repositories");
    expect(count(0, "review")).toBe("0 reviews");
    expect(count(1200, "finding")).toBe("1,200 findings");
  });

  it("names a time range in days on every page", () => {
    expect([7, 30].map(period)).toEqual([
      { value: 7, label: "7 days" },
      { value: 30, label: "30 days" },
    ]);
  });

  it("keeps a list's time column short", () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
    expect(since(daysAgo(2))).toBe("2d");
    expect(since(daysAgo(400))).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
  });

  it("dates an old time by its month's name, not a numeric date", () => {
    expect(ago("2026-01-03T12:00:00Z")).toMatch(/Jan/);
  });
});
