import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullItem } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { inboxSections, type Row, rowsOf, sectionOf } from "./inbox/sections.js";
import { Inbox } from "./pages/Inbox.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  await clearCache();
});

const pull = (n: number, over: Partial<PullItem> = {}): PullItem => ({
  id: String(n),
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/octo/api/pull/${n}`,
  repo: "octo/api",
  author: "octo",
  draft: false,
  state: "open",
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-21T10:00:00Z",
  mergedAt: null,
  roles: ["author"],
  checks: null,
  review: null,
  additions: null,
  deletions: null,
  ...over,
});

const answer = {
  platforms: [
    {
      platform: "github" as const,
      host: "github.com",
      linked: true,
      failed: false,
      more: false,
      pulls: [
        pull(1, { roles: ["reviewer"], author: "ada", checks: "failing" }),
        pull(2, { roles: ["reviewer"], author: "ada", title: "Fix login" }),
        pull(3, { review: "approved" }),
        pull(4, { review: "changes_requested", repo: "octo/web" }),
        pull(5, { draft: true }),
        pull(6),
        pull(7, { state: "merged", mergedAt: "2026-11-21T09:00:00Z" }),
      ],
    },
    {
      platform: "gitlab" as const,
      host: "gitlab.example.com",
      linked: false,
      failed: false,
      more: false,
      pulls: [],
    },
  ],
};

describe("the inbox's sections", () => {
  it("put each pull where it waits on someone", () => {
    expect(answer.platforms[0]?.pulls.map((p) => [p.number, sectionOf(p)])).toEqual([
      [1, "review"],
      [2, "review"],
      [3, "approved"],
      [4, "returned"],
      [5, "drafts"],
      [6, "waiting"],
      [7, "merged"],
    ]);
  });

  it("leave out a draft asking your review, and your own pull asking it", () => {
    expect(sectionOf(pull(8, { roles: ["reviewer"], draft: true }))).toBeNull();
    expect(sectionOf(pull(9, { roles: ["reviewer", "author"] }))).toBe("waiting");
  });

  it("filter by text and by repository", () => {
    const rows = rowsOf(answer);
    const numbers = (f: { text: string; repo: string }) =>
      inboxSections(rows, f).flatMap((s) => s.rows.map((r: Row) => r.number));
    expect(numbers({ text: "LOGIN", repo: "" })).toEqual([2]);
    expect(numbers({ text: "", repo: "github.com/octo/web" })).toEqual([4]);
  });
});

describe("the inbox page", () => {
  const show = async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(answer)),
    );
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    return open;
  };
  const current = () => document.querySelector("[aria-current='true']")?.getAttribute("href");
  const key = (k: string, on: Element = document.body) =>
    act(() => void fireEvent.keyDown(on, { key: k }));

  it("walks the rows in section order with j and k and opens one with Enter", async () => {
    const open = await show();
    expect(screen.getByText(/gitlab.example.com is not connected/)).toBeTruthy();
    expect(document.title).toMatch(/^\(2\) /);
    expect(current()).toBe("https://github.com/octo/api/pull/1");
    key("j");
    key("j");
    expect(current()).toBe("https://github.com/octo/api/pull/3");
    key("k");
    key("Enter");
    expect(open).toHaveBeenCalledWith(
      "https://github.com/octo/api/pull/2",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("skips a folded section and remembers it", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: /Needs your review/ }));
    expect(screen.queryByText("Change 1")).toBeNull();
    expect(current()).toBe("https://github.com/octo/api/pull/3");
    expect(localStorage.getItem("ocra-inbox-collapsed")).toBe('["review"]');
  });

  it("leaves keys typed in the finder to it", async () => {
    await show();
    key("/");
    const box = screen.getByLabelText("Find");
    expect(document.activeElement).toBe(box);
    key("j", box);
    expect(current()).toBe("https://github.com/octo/api/pull/1");
  });
});
