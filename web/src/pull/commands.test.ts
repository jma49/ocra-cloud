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
  toggleViewed: vi.fn(),
  beside: null,
});
const keys = (over: Partial<PullFilesView>) => pullCommands(page(over)).map((c) => c.key);

describe("a pull request's commands", () => {
  it("offer only what the pull request still takes", () => {
    expect(keys({})).toEqual(["r", "c", "j", "k", "n", "N", "v", "m", "o"]);
    expect(keys({ state: "merged" })).toEqual(["r", "c", "j", "k", "n", "N", "v", "o"]);
    expect(keys({ verdicts: [], url: null })).toEqual(["c", "j", "k", "n", "N", "v", "m"]);
    expect(pullCommands({ ...page({}), data: undefined })).toEqual([]);
    const beside = { at: 1, total: 2, previous: null, next: "/pull/github/octo%2Fapi/8" };
    expect(pullCommands({ ...page({}), beside }).map((c) => c.key)).toContain("]");
    expect(pullCommands({ ...page({}), beside }).map((c) => c.key)).not.toContain("[");
  });

  it("opens the review on r", () => {
    const p = page({});
    pullCommands(p)
      .find((c) => c.key === "r")
      ?.run();
    expect(p.review).toHaveBeenCalled();
  });

  it("opens Ask ocra on q, where the page offers it", () => {
    const ask = vi.fn();
    expect(keys({})).not.toContain("q");
    pullCommands({ ...page({}), ask })
      .find((c) => c.key === "q")
      ?.run();
    expect(ask).toHaveBeenCalled();
  });

  it("ticks the file being read on v", () => {
    const code = document.createElement("div");
    const file = (path: string, top: number) => {
      const el = document.createElement("section");
      el.className = "diff-file";
      el.dataset.path = path;
      el.getBoundingClientRect = () => ({ top }) as DOMRect;
      code.append(el);
    };
    file("a.ts", -40);
    file("b.ts", 300);
    const p = { ...page({}), code: { current: code } };
    pullCommands(p)
      .find((c) => c.key === "v")
      ?.run();
    expect(p.toggleViewed).toHaveBeenCalledWith("a.ts");
  });

  it("moves to ocra's next and previous finding on the diff with n and N", () => {
    const code = document.createElement("div");
    const shown: string[] = [];
    const note = (title: string, top: number) => {
      const el = document.createElement("section");
      el.className = "finding-note";
      el.getBoundingClientRect = () => ({ top, height: 100 }) as DOMRect;
      el.scrollIntoView = () => void shown.push(title);
      code.append(el);
    };
    vi.stubGlobal("innerHeight", 800);
    note("above", -300);
    note("here", 350);
    note("below", 900);
    const run = (key: string) =>
      pullCommands({ ...page({}), code: { current: code } })
        .find((c) => c.key === key)
        ?.run();
    run("n");
    run("N");
    vi.unstubAllGlobals();
    expect(shown).toEqual(["below", "above"]);
  });

  it("puts the keys on the merge button with m, and on a finding's first action with n", () => {
    const merge = document.createElement("div");
    merge.id = "merge";
    merge.innerHTML = "<button disabled>Merge</button><button>Merge when ready</button>";
    merge.scrollIntoView = () => undefined;
    document.body.append(merge);
    pullCommands(page({}))
      .find((c) => c.key === "m")
      ?.run();
    expect(document.activeElement?.textContent).toBe("Merge when ready");
    merge.remove();

    const code = document.createElement("div");
    const note = document.createElement("section");
    note.className = "finding-note";
    note.innerHTML = "<button>Mark fixed</button><button>Dismiss</button>";
    note.getBoundingClientRect = () => ({ top: 900, height: 100 }) as DOMRect;
    note.scrollIntoView = () => undefined;
    code.append(note);
    document.body.append(code);
    vi.stubGlobal("innerHeight", 800);
    const say = vi.fn();
    const run = (key: string, current: HTMLElement) =>
      pullCommands({ ...page({}), code: { current }, say })
        .find((c) => c.key === key)
        ?.run();
    run("n", code);
    expect(document.activeElement?.textContent).toBe("Mark fixed");
    run("N", code);
    expect(say).toHaveBeenLastCalledWith("No findings above");
    run("n", document.createElement("div"));
    expect(say).toHaveBeenLastCalledWith("No open findings on this diff");
    vi.unstubAllGlobals();
    code.remove();
  });
});
