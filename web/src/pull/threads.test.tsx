import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullThreadsView, ReviewThreadView } from "../../../src/shared/index.js";
import { ThreadsPanel } from "./threads.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const thread = (id: string, path: string, over: Partial<ReviewThreadView> = {}) =>
  ({
    id,
    path,
    line: 11,
    startLine: null,
    side: "new",
    resolved: false,
    outdated: false,
    canResolve: true,
    comments: [
      {
        id: `${id}c`,
        author: "rev",
        body: `Note on ${id}`,
        createdAt: null,
        suggestions: [
          {
            id: `${id}:0`,
            startLine: 10,
            endLine: 11,
            replacement: `fix ${id}`,
            applicable: true,
            applied: false,
          },
        ],
      },
    ],
    ...over,
  }) satisfies ReviewThreadView;

const show = async (platform: string, threads: ReviewThreadView[]) => {
  const view: PullThreadsView = { head: "abc", truncated: false, threads };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(view)),
  );
  render(<ThreadsPanel pull={{ platform, repo: "octo/api", number: 7 }} onDone={() => {}} />);
  await screen.findByRole("region", { name: "Review threads" });
};
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("the review threads panel", () => {
  it("lets GitHub suggestions be picked together only within one file", async () => {
    await show("github", [
      thread("A", "src/a.ts"),
      thread("B", "src/a.ts", { line: 20 }),
      thread("C", "src/b.ts"),
    ]);
    const [a, b, c] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(a as HTMLElement);
    expect([a?.disabled, b?.disabled, c?.disabled]).toEqual([false, false, true]);
    fireEvent.click(a as HTMLElement);
    expect(c?.disabled).toBe(false);
  });

  it("leaves GitLab suggestions in several files free to pick", async () => {
    await show("gitlab", [thread("A", "src/a.ts"), thread("C", "src/b.ts")]);
    const [a, c] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(a as HTMLElement);
    expect(c?.disabled).toBe(false);
    fireEvent.click(c as HTMLElement);
    expect(screen.getByRole("button", { name: "Commit 2 suggestions" })).toBeTruthy();
  });

  it("names the lines a suggestion replaces, counts the threads and offers no commit for resolved ones", async () => {
    await show("github", [thread("A", "src/a.ts")]);
    expect(box("Apply to lines 10–11")).toBeTruthy();
    expect(screen.getByText("1 open")).toBeTruthy();
    cleanup();
    await show("github", [thread("R", "src/a.ts", { resolved: true })]);
    expect(screen.getByText("1 resolved")).toBeTruthy();
    expect(screen.getByText("1 comment")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Commit/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  });
});
