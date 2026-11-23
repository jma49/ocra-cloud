import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queuePlace, queueRemoval, queueSize } from "./queue-words.js";

const entry = {
  state: "checking" as const,
  position: 3,
  enqueuedAt: "2026-11-23T09:56:00Z",
  enqueuedBy: "octo",
  estimate: 420,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("a merge queue entry in words", () => {
  it("says where it is, when it should merge and since when, in that order", () => {
    expect(queuePlace(entry, 5)).toEqual([
      "3rd of 5",
      "merges in about 7m",
      "queued 4m ago by octo",
    ]);
  });

  it("says only what the platform told it", () => {
    const bare = { ...entry, position: null, enqueuedAt: null, enqueuedBy: null, estimate: null };
    expect(queuePlace(bare, null)).toEqual([]);
    expect(queuePlace({ ...bare, position: 12 }, null)).toEqual(["12th in line"]);
    expect(queuePlace({ ...bare, position: 21, estimate: 30 }, 22)).toEqual([
      "21st of 22",
      "merges in about 1m",
    ]);
    expect(queuePlace({ ...bare, estimate: 7200 }, null)).toEqual(["merges in about 2h"]);
  });

  it("gives the platform's reason for a removal, else who took it out", () => {
    const at = "2026-11-23T09:58:00Z";
    expect(queueRemoval({ at, by: "octo", reason: "CI checks failed." })).toBe(
      "Left the queue 2m ago: CI checks failed.",
    );
    expect(queueRemoval({ at, by: "octo", reason: null })).toBe(
      "octo took it out of the queue 2m ago.",
    );
    expect(queueRemoval({ at, by: null, reason: null })).toBe("Left the queue 2m ago.");
  });

  it("counts what the queue holds", () => {
    expect(queueSize(0)).toBe("The queue is empty now.");
    expect(queueSize(1)).toBe("1 pull request in the queue now.");
    expect(queueSize(4)).toBe("4 pull requests in the queue now.");
  });
});
