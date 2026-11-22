import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PULL_VIEWS, type PullItem } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
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
  labels: [],
  verdict: null,
  additions: null,
  deletions: null,
  head: `head${n}`,
  unread: false,
  repliesWaiting: 0,
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
        pull(1, { roles: ["reviewer"], author: "ada", unread: true, unreadReason: "commits" }),
        pull(2, { roles: ["reviewer"], author: "ada" }),
        pull(3, { unread: true, unreadReason: "ocra_review" }),
      ],
    },
  ],
};

const show = async (refuse = false) => {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pull-views") {
        return Response.json({ views: [], defaults: DEFAULT_PULL_VIEWS });
      }
      if (url !== "/api/pulls/seen/bulk") return Response.json(answer);
      sent.push(JSON.parse(String(init?.body)));
      return refuse ? Response.json({ error: "internal" }, { status: 500 }) : Response.json({});
    }),
  );
  render(<Inbox />);
  await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
  return sent;
};
const unreadNumbers = () => [
  ...new Set(
    [...document.querySelectorAll(".pull-line.unread .pull-num")].map((n) => n.textContent),
  ),
];
const click = (name: string) =>
  act(() => void fireEvent.click(screen.getAllByRole("button", { name })[0] as HTMLElement));

describe("the inbox's unread marks", () => {
  it("show which pull requests changed and why, and mark one read with what the list saw", async () => {
    const sent = await show();
    expect(unreadNumbers()).toEqual(["#1", "#3"]);
    expect(screen.getAllByRole("button", { name: "Mark #1 read" })[0]?.title).toBe(
      "New commits. Mark read",
    );
    await click("Mark #1 read");
    expect(unreadNumbers()).toEqual(["#3"]);
    expect(sent).toEqual([
      {
        read: true,
        pulls: [
          {
            platform: "github",
            repo: "octo/api",
            number: 1,
            updatedAt: "2026-11-21T10:00:00Z",
            head: "head1",
          },
        ],
      },
    ]);
  });

  it("mark the current row unread and read again with u", async () => {
    const sent = await show();
    await act(() => void fireEvent.keyDown(document.body, { key: "j" }));
    await act(() => void fireEvent.keyDown(document.body, { key: "u" }));
    expect(unreadNumbers()).toEqual(["#1", "#2", "#3"]);
    expect(sent).toEqual([
      { read: false, pulls: [{ platform: "github", repo: "octo/api", number: 2 }] },
    ]);
    await act(() => void fireEvent.keyDown(document.body, { key: "u" }));
    expect(unreadNumbers()).toEqual(["#1", "#3"]);
  });

  it("mark everything read at once, and offer it only while something is unread", async () => {
    const sent = await show();
    await click("Mark all read");
    expect(unreadNumbers()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect((sent[0] as { pulls: { number: number }[] }).pulls.map((p) => p.number)).toEqual([1, 3]);
  });

  it("take the mark back and say so when the server refuses", async () => {
    await show(true);
    await click("Mark #3 read");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not mark/));
    expect(unreadNumbers()).toEqual(["#1", "#3"]);
  });
});
