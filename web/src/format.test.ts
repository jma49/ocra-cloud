import { describe, expect, it } from "vitest";
import { ago, count, period } from "./format.js";

describe("how counts and times read", () => {
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

  it("dates an old time by its month's name, not a numeric date", () => {
    expect(ago("2026-01-03T12:00:00Z")).toMatch(/Jan/);
  });
});
