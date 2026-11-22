import { describe, expect, it } from "vitest";
import { chainTo, MAX_STACK, type OpenPull, stackOf } from "../src/platforms/stacks.js";

// A stack read from the open pull requests' branches alone (ADR-0052).

const pull = (number: number, head: string, base: string): OpenPull => ({
  number,
  title: `#${number}`,
  url: `https://example.test/${number}`,
  draft: false,
  head,
  base,
  headSha: String(number).padStart(40, "0"),
  checks: null,
  review: null,
});

const shape = (pulls: { number: number; parent: number | null }[]) =>
  pulls.map((p) => [p.number, p.parent]);

describe("a stack of pull requests", () => {
  const open = [
    pull(12, "c", "b"),
    pull(10, "a", "main"),
    pull(11, "b", "a"),
    pull(20, "other", "main"),
  ];

  it("orders the chain from the bottom, whichever of it is asked for", () => {
    for (const n of [10, 11, 12]) {
      const stack = stackOf(open, n);
      expect(stack?.trunk).toBe("main");
      expect(shape(stack?.pulls ?? [])).toEqual([
        [10, null],
        [11, 10],
        [12, 11],
      ]);
    }
  });

  it("is the pull request alone when nothing is stacked on or under it", () => {
    expect(shape(stackOf(open, 20)?.pulls ?? [])).toEqual([[20, null]]);
  });

  it("is nothing for a pull request that is not open", () => {
    expect(stackOf(open, 99)).toBeNull();
  });

  it("keeps a fork in the stack, each branch after its parent", () => {
    const forked = [...open, pull(13, "d", "a")];
    expect(shape(stackOf(forked, 13)?.pulls ?? [])).toEqual([
      [10, null],
      [11, 10],
      [12, 11],
      [13, 10],
    ]);
    expect(chainTo(stackOf(forked, 13)?.pulls ?? [], 13).map((p) => p.number)).toEqual([10, 13]);
  });

  it("ends a cycle of branches instead of walking it forever", () => {
    const cycle = [pull(1, "x", "y"), pull(2, "y", "x")];
    expect(
      stackOf(cycle, 1)
        ?.pulls.map((p) => p.number)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("cuts a cycle above its lowest number, as the inbox does, whichever is asked for", () => {
    const cycle = [pull(2, "y", "x"), pull(1, "x", "z"), pull(3, "z", "y")];
    for (const n of [1, 2, 3]) {
      expect(shape(stackOf(cycle, n)?.pulls ?? [])).toEqual([
        [1, null],
        [2, 1],
        [3, 2],
      ]);
    }
  });

  it("does not stack a pull request on itself", () => {
    expect(shape(stackOf([pull(7, "a", "a")], 7)?.pulls ?? [])).toEqual([[7, null]]);
  });

  it("takes the oldest of two pull requests from one head branch as the parent", () => {
    const twice = [pull(5, "a", "main"), pull(4, "a", "release"), pull(6, "b", "a")];
    expect(stackOf(twice, 6)?.pulls[0]?.number).toBe(4);
  });

  it("holds at most a bounded number of pull requests", () => {
    const long = Array.from({ length: MAX_STACK + 5 }, (_, i) =>
      pull(i + 1, `b${i + 1}`, i === 0 ? "main" : `b${i}`),
    );
    expect(stackOf(long, 1)?.pulls).toHaveLength(MAX_STACK);
  });

  it("chains from the bottom up to the one asked for, not past it", () => {
    const stack = stackOf(open, 12)?.pulls ?? [];
    expect(chainTo(stack, 11).map((p) => p.number)).toEqual([10, 11]);
    expect(chainTo(stack, 99)).toEqual([]);
  });
});
