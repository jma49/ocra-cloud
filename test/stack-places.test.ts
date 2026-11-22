import { describe, expect, it } from "vitest";
import { type StackBranches, stackPlaces } from "../src/shared/index.js";

// The inbox's stacks, read from the listed pulls' branches alone.

const pull = (number: number, head: string, base: string, repo = "octo/api"): StackBranches => ({
  repo,
  number,
  head,
  base,
});

const places = (pulls: StackBranches[]) =>
  stackPlaces(pulls).map((s, i) => [
    pulls[i]?.number,
    s ? `${s.id} ${s.position}/${s.size}` : null,
  ]);

describe("stacks in the pull request inbox", () => {
  it("numbers a chain from its bottom, whatever order it is listed in", () => {
    expect(places([pull(12, "c", "b"), pull(10, "a", "main"), pull(11, "b", "a")])).toEqual([
      [12, "octo/api#10 3/3"],
      [10, "octo/api#10 1/3"],
      [11, "octo/api#10 2/3"],
    ]);
  });

  it("gives a pull with nothing stacked on or under it no place", () => {
    expect(places([pull(1, "a", "main"), pull(2, "b", "main")])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it("groups what is listed of a partial stack and counts only that", () => {
    // #11 (b on a) is not listed: #12 is cut from #10, and #13 still sits on #12.
    expect(places([pull(10, "a", "main"), pull(12, "c", "b"), pull(13, "d", "c")])).toEqual([
      [10, null],
      [12, "octo/api#12 1/2"],
      [13, "octo/api#12 2/2"],
    ]);
  });

  it("does not stack across repositories that share branch names", () => {
    expect(places([pull(1, "a", "main", "octo/api"), pull(2, "b", "a", "octo/web")])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it("orders a fork depth first, each branch after its parent, lower numbers first", () => {
    const pulls = [
      pull(14, "e", "b"),
      pull(10, "a", "main"),
      pull(12, "c", "a"),
      pull(11, "b", "a"),
      pull(13, "d", "b"),
    ];
    expect(places(pulls)).toEqual([
      [14, "octo/api#10 4/5"],
      [10, "octo/api#10 1/5"],
      [12, "octo/api#10 5/5"],
      [11, "octo/api#10 2/5"],
      [13, "octo/api#10 3/5"],
    ]);
  });

  it("takes the lower number of two pulls from one head branch as the parent", () => {
    expect(places([pull(21, "a", "release"), pull(20, "a", "main"), pull(22, "b", "a")])).toEqual([
      [21, null],
      [20, "octo/api#20 1/2"],
      [22, "octo/api#20 2/2"],
    ]);
  });

  it("cuts a cycle of branches above its lowest number, whichever pull it starts from", () => {
    const cycle = [pull(31, "b", "a"), pull(30, "a", "c"), pull(32, "c", "b"), pull(33, "d", "c")];
    const expected = [
      [31, "octo/api#30 2/4"],
      [30, "octo/api#30 1/4"],
      [32, "octo/api#30 3/4"],
      [33, "octo/api#30 4/4"],
    ];
    expect(places(cycle)).toEqual(expected);
    const reversed = [...cycle].reverse();
    expect(places(reversed)).toEqual([...expected].reverse());
  });

  it("ignores a pull whose base is its own head", () => {
    expect(places([pull(40, "a", "a")])).toEqual([[40, null]]);
  });
});
