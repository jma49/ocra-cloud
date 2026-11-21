import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullItem } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { inboxSections, matchesView, type Row, rowsOf, sectionOf } from "./inbox/sections.js";
import { sharedView, shareLink } from "./inbox/views.js";
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

describe("an account's own sections", () => {
  const rows = rowsOf(answer);
  const numbers = (f: Parameters<typeof matchesView>[1]) =>
    rows.filter((r) => matchesView(r, f)).map((r) => r.number);

  it("match every group set, and any choice within one", () => {
    expect(numbers({})).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(numbers({ roles: ["author"], states: ["open"], drafts: "exclude" })).toEqual([3, 4, 6]);
    expect(numbers({ checks: ["failing"] })).toEqual([1]);
    expect(numbers({ reviews: ["approved", "changes_requested"] })).toEqual([3, 4]);
    expect(numbers({ drafts: "only" })).toEqual([5]);
    expect(numbers({ authors: ["ada"], repos: ["github.com/octo/api"] })).toEqual([1, 2]);
  });

  it("come after the fixed ones", () => {
    const view = {
      id: "v1",
      name: "Failing",
      position: 0,
      filters: { checks: ["failing" as const] },
    };
    const shown = inboxSections(rows, { text: "", repo: "" }, [view]);
    expect(shown.at(-1)).toMatchObject({ key: "view:v1", title: "Failing" });
    expect(shown.at(-1)?.rows.map((r) => r.number)).toEqual([1]);
  });

  it("travel in a link, names and all, and a broken link offers nothing", () => {
    const view = { name: "Équipe web", filters: { repos: ["github.com/octo/web"] } };
    const link = new URL(shareLink(view));
    expect(link.pathname).toBe("/pulls");
    expect(sharedView(link.search)).toEqual(view);
    expect(sharedView("?section=%%%")).toBeNull();
    expect(sharedView("")).toBeNull();
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

  it("saves a new section and shows it at once", async () => {
    const posted: unknown[] = [];
    let views: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/pull-views" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posted.push(body);
          views = [{ id: "v1", position: 0, ...body }];
          return Response.json(views[0], { status: 201 });
        }
        if (url === "/api/pull-views") return Response.json({ views });
        return Response.json(answer);
      }),
    );
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New section" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Web" } });
    fireEvent.click(screen.getByLabelText("github.com/octo/web"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(posted).toEqual([
      {
        name: "Web",
        filters: { roles: ["author"], states: ["open"], repos: ["github.com/octo/web"] },
      },
    ]);
    await waitFor(() => expect(screen.getByRole("region", { name: "Web" })).toBeTruthy());
  });

  it("asks to connect a platform when none is linked, once instead of each section", async () => {
    const none = answer.platforms.map((p) => ({ ...p, linked: false, pulls: [] }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ platforms: none })),
    );
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Connect a platform")).toBeTruthy());
    expect(screen.queryByRole("region", { name: "Approved" })).toBeNull();
    expect(screen.queryByText(/is not connected/)).toBeNull();
  });

  it("says nothing waits when every section is empty, and what to clear when a search empties them", async () => {
    await show();
    expect(screen.queryByText("Nothing waits on you")).toBeNull();
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "no such pull" } });
    expect(screen.getByText("No pull request matches")).toBeTruthy();
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
