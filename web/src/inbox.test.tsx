import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PULL_VIEWS, type PullItem, type PullView } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { inboxSections, matchesView, type Row, reviewAsked, rowsOf } from "./inbox/sections.js";
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
  labels: [],
  verdict: null,
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

const defaults: PullView[] = DEFAULT_PULL_VIEWS.map((d, position) => ({
  id: `default:${position}`,
  position,
  hidden: false,
  ...d,
}));
const noViews = { views: [], defaults: DEFAULT_PULL_VIEWS };

describe("the inbox's sections", () => {
  const rows = rowsOf(answer);

  it("are the views in their order, each with what it matches, a hidden one left out", () => {
    const [review, mine, waiting, merged] = defaults;
    const shown = inboxSections(rows, { text: "", repo: "" }, [
      review as PullView,
      { ...(mine as PullView), hidden: true },
      waiting as PullView,
      merged as PullView,
    ]);
    expect(shown.map((s) => [s.title, s.rows.map((r) => r.number)])).toEqual([
      ["Needs my review", [1, 2]],
      ["Waiting on others", [6]],
      ["Recently merged", [7]],
    ]);
  });

  it("count for the tab's title what asks the user's review, not a draft or their own", () => {
    expect(reviewAsked(rows)).toBe(2);
    expect(
      reviewAsked(
        rowsOf({
          platforms: [
            {
              ...answer.platforms[0],
              pulls: [
                pull(8, { roles: ["reviewer"], draft: true }),
                pull(9, { roles: ["reviewer", "author"] }),
              ],
            },
          ] as typeof answer.platforms,
        }),
      ),
    ).toBe(0);
  });

  it("filter by text and by repository", () => {
    const numbers = (f: { text: string; repo: string }) => [
      ...new Set(inboxSections(rows, f, defaults).flatMap((s) => s.rows.map((r: Row) => r.number))),
    ];
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
      vi.fn(async (url: string) => Response.json(url === "/api/pull-views" ? noViews : answer)),
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

  it("walks the rows in section order with j and k, opens one here with Enter and on the platform with o", async () => {
    const open = await show();
    expect(screen.getByText(/gitlab.example.com is not connected/)).toBeTruthy();
    await waitFor(() => expect(document.title).toMatch(/^\(2\) /));
    expect(current()).toBe("/pull/github/octo%2Fapi/1");
    key("j");
    key("j");
    expect(current()).toBe("/pull/github/octo%2Fapi/3");
    key("k");
    key("o");
    expect(open).toHaveBeenCalledWith(
      "https://github.com/octo/api/pull/2",
      "_blank",
      "noopener,noreferrer",
    );
    key("Enter");
    expect(location.pathname).toBe("/pull/github/octo%2Fapi/2");
  });

  it("skips a folded section and remembers it", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: /^Needs my review/ }));
    expect(screen.queryByText("Change 1")).toBeNull();
    expect(current()).toBe("/pull/github/octo%2Fapi/3");
    expect(localStorage.getItem("ocra-inbox-collapsed")).toBe('["view:default:0"]');
  });

  const kept = (): PullView[] => defaults.map((d, i) => ({ ...d, id: `v${i}` }));
  /** A server that keeps the defaults when asked, then takes each change. */
  const serve = () => {
    const sent: { method: string; url: string; body: unknown }[] = [];
    let views: PullView[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (!url.startsWith("/api/pull-views")) return Response.json(answer);
        if (method === "GET")
          return Response.json(views.length ? { views, defaults: [] } : noViews);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        sent.push({ method, url, body });
        if (url.endsWith("/defaults")) views = kept();
        else if (url.endsWith("/order")) {
          views = views.map((v) => ({ ...v, position: body.ids.indexOf(v.id) }));
        } else if (method === "POST") {
          views = [...views, { id: "v9", position: views.length, hidden: false, ...body }];
        } else views = views.map((v) => (url.endsWith(`/${v.id}`) ? { ...v, ...body } : v));
        return Response.json({ views });
      }),
    );
    return sent;
  };
  const regions = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  const choose = async (section: string, item: string) => {
    fireEvent.click(screen.getByRole("button", { name: `Section ${section}` }));
    await act(
      async () => void fireEvent.click(await screen.findByRole("menuitem", { name: item })),
    );
  };

  it("keeps the defaults as the account's own before adding a section to them", async () => {
    const sent = serve();
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New section" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Web" } });
    fireEvent.click(screen.getByLabelText("github.com/octo/web"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(sent).toEqual([
      { method: "POST", url: "/api/pull-views/defaults", body: null },
      {
        method: "POST",
        url: "/api/pull-views",
        body: {
          name: "Web",
          filters: { roles: ["author"], states: ["open"], repos: ["github.com/octo/web"] },
        },
      },
    ]);
    await waitFor(() => expect(regions().at(-1)).toBe("Web"));
    expect(regions()).toHaveLength(5);
  });

  it("edits who opened it, ocra's verdict, labels and how lately it changed, keeping what it had", async () => {
    const sent = serve();
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    await choose("Needs my review", "Edit");
    expect((screen.getByLabelText("Opened by") as HTMLSelectElement).value).toBe("others");
    fireEvent.change(screen.getByLabelText("Opened by"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Blocking"));
    fireEvent.change(screen.getByLabelText("Labels"), { target: { value: "bug, Urgent ," } });
    fireEvent.change(screen.getByLabelText("Updated"), { target: { value: "7" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      url: "/api/pull-views/v0",
      body: {
        name: "Needs my review",
        hidden: false,
        filters: {
          roles: ["reviewer"],
          states: ["open"],
          drafts: "exclude",
          verdicts: ["blocking"],
          labels: ["bug", "Urgent"],
          updatedWithinDays: 7,
        },
      },
    });
  });

  it("moves a section, hides it and shows it again", async () => {
    const sent = serve();
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
    await choose("My open PRs", "Move up");
    await waitFor(() => expect(regions().slice(0, 2)).toEqual(["My open PRs", "Needs my review"]));
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      url: "/api/pull-views/order",
      body: { ids: ["v1", "v0", "v2", "v3"] },
    });
    await choose("Recently merged", "Hide");
    await waitFor(() => expect(regions()).not.toContain("Recently merged"));
    expect(sent.at(-1)).toMatchObject({ url: "/api/pull-views/v3", body: { hidden: true } });
    await act(
      async () =>
        void fireEvent.click(screen.getByRole("button", { name: "Show Recently merged" })),
    );
    await waitFor(() => expect(regions()).toContain("Recently merged"));
    expect(sent.at(-1)).toMatchObject({
      url: "/api/pull-views/v3",
      body: { name: "Recently merged", hidden: false },
    });
  });

  it("asks to connect a platform when none is linked, once instead of each section", async () => {
    const none = answer.platforms.map((p) => ({ ...p, linked: false, pulls: [] }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url === "/api/pull-views" ? noViews : { platforms: none }),
      ),
    );
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("Connect a platform")).toBeTruthy());
    expect(screen.queryByRole("region", { name: "My open PRs" })).toBeNull();
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
    expect(current()).toBe("/pull/github/octo%2Fapi/1");
  });
});
