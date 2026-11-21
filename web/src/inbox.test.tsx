import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullItem } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { Inbox, inboxRows } from "./pages/Inbox.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const pull = (n: number, over: Partial<PullItem> = {}): PullItem => ({
  id: String(n),
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/octo/api/pull/${n}`,
  repo: "octo/api",
  author: "ada",
  draft: false,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-21T10:00:00Z",
  sections: ["review"],
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
        pull(1, { checks: "failing" }),
        pull(2, { sections: ["review", "authored"], draft: true }),
        pull(3, { sections: ["authored"], review: "approved", title: "Fix login" }),
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

describe("the inbox's rows", () => {
  it("show a pull once, under review, when it is in both lists", () => {
    const s = inboxRows(answer, "all", "", true);
    expect(s.map((x) => [x.section, x.rows.map((r) => r.number)])).toEqual([
      ["review", [1, 2]],
      ["authored", [3]],
    ]);
    expect(inboxRows(answer, "authored", "", true)[0]?.rows.map((r) => r.number)).toEqual([2, 3]);
  });

  it("filter by text and leave drafts out when asked", () => {
    expect(
      inboxRows(answer, "all", "LOGIN", true).flatMap((s) => s.rows.map((r) => r.number)),
    ).toEqual([3]);
    expect(inboxRows(answer, "all", "", false).flatMap((s) => s.rows.map((r) => r.number))).toEqual(
      [1, 3],
    );
  });
});

describe("the inbox page", () => {
  it("walks the rows with j and k and opens the current one with Enter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(answer)),
    );
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    expect(screen.getByText("Checks fail")).toBeTruthy();
    expect(screen.getByText(/gitlab.example.com is not connected/)).toBeTruthy();
    const current = () => document.querySelector("[aria-current='true']")?.getAttribute("href");
    expect(current()).toBe("https://github.com/octo/api/pull/1");
    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
      fireEvent.keyDown(document.body, { key: "j" });
    });
    expect(current()).toBe("https://github.com/octo/api/pull/3");
    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
      fireEvent.keyDown(document.body, { key: "k" });
    });
    expect(current()).toBe("https://github.com/octo/api/pull/2");
    act(() => {
      fireEvent.keyDown(document.body, { key: "Enter" });
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/octo/api/pull/2",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("leaves keys typed in the filter to the filter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(answer)),
    );
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    const box = screen.getByLabelText("Filter");
    act(() => {
      fireEvent.keyDown(document.body, { key: "/" });
    });
    expect(document.activeElement).toBe(box);
    act(() => {
      fireEvent.keyDown(box, { key: "j" });
    });
    expect(document.querySelector("[aria-current='true']")?.getAttribute("href")).toBe(
      "https://github.com/octo/api/pull/1",
    );
  });
});
