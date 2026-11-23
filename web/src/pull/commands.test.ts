import { describe, expect, it, vi } from "vitest";
import type { PullFilesView } from "../../../src/shared/index.js";
import { pullCommands } from "./commands.js";

const page = (over: Partial<PullFilesView>) => ({
  data: {
    state: "open",
    url: "https://github.com/octo/api/pull/7",
    verdicts: ["approve"],
    ...over,
  } as PullFilesView,
  code: { current: null },
  review: vi.fn(),
});
const keys = (over: Partial<PullFilesView>) => pullCommands(page(over)).map((c) => c.key);

describe("a pull request's commands", () => {
  it("offer only what the pull request still takes", () => {
    expect(keys({})).toEqual(["r", "c", "j", "k", "m", "o"]);
    expect(keys({ state: "merged" })).toEqual(["r", "c", "j", "k", "o"]);
    expect(keys({ verdicts: [], url: null })).toEqual(["c", "j", "k", "m"]);
    expect(pullCommands({ ...page({}), data: undefined })).toEqual([]);
  });

  it("opens the review on r", () => {
    const p = page({});
    pullCommands(p)
      .find((c) => c.key === "r")
      ?.run();
    expect(p.review).toHaveBeenCalled();
  });
});
