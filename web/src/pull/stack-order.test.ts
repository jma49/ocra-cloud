import { describe, expect, it } from "vitest";
import { stackBeside, stackLanes } from "./stack-order.js";

const chain = [
  { number: 1, parent: null },
  { number: 2, parent: 1 },
  { number: 3, parent: 2 },
];
const fork = [...chain, { number: 4, parent: 1 }, { number: 5, parent: 4 }];

describe("a stack's order on the page", () => {
  it("keeps a chain in one column", () => {
    expect([...stackLanes(chain).values()]).toEqual([0, 0, 0]);
  });

  it("starts each further branch of a fork one column to the right, its own chain with it", () => {
    expect([...stackLanes(fork)]).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 1],
    ]);
  });

  it("names the layer under a pull request and the first one on it", () => {
    expect(stackBeside(fork, 1)).toEqual({ down: null, up: 2 });
    expect(stackBeside(fork, 4)).toEqual({ down: 1, up: 5 });
    expect(stackBeside(fork, 3)).toEqual({ down: 2, up: null });
    expect(stackBeside(fork, 9)).toEqual({ down: null, up: null });
  });
});
