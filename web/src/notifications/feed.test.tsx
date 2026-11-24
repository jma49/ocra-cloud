import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedItemView } from "../../../src/shared/index.js";
import { FeedBell } from "./feed.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const notice = (over: Partial<FeedItemView>): FeedItemView => ({
  id: "n1",
  kind: "review_requested",
  at: new Date().toISOString(),
  read: false,
  title: "Mira asked for your review",
  subtitle: "Bound the retry loop",
  link: "/pull/github/octo/api/7",
  repo: "octo/api",
  pull: 7,
  ...over,
});

/** Answers the feed's routes from `items`, and keeps what was posted. */
function serve(items: FeedItemView[], next?: string) {
  const posted: unknown[] = [];
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(url);
      const unread = items.filter((i) => !i.read).length;
      if (url === "/api/notifications/feed/unread") return Response.json({ unread });
      if (url === "/api/notifications/feed/read") {
        posted.push(JSON.parse(String(init?.body)));
        return Response.json({ unread: 0 });
      }
      if (url === "/api/notifications/feed") return Response.json({ items, unread, next });
      if (url.startsWith("/api/notifications/feed?before="))
        return Response.json({
          items: [notice({ id: "old", read: true, title: "Earlier" })],
          unread,
        });
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return { posted, asked };
}

const bell = () => render(<FeedBell tip={(_label: string, control: ReactElement) => control} />);
const press = (name: string | RegExp) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("the notification centre", () => {
  it("says on the bell how many are unread, and nothing when none is", async () => {
    serve([notice({}), notice({ id: "n2", read: true })]);
    bell();
    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
    cleanup();
    serve([]);
    bell();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  });

  it("lists the notices, and marks one read as it is opened", async () => {
    const { posted } = serve([
      notice({}),
      notice({ id: "n2", read: true, title: "Checks failed" }),
    ]);
    bell();
    await press(/^Notifications/);
    const unread = await screen.findByRole("link", { name: /Mira asked for your review/ });
    expect(unread.getAttribute("href")).toBe("/pull/github/octo/api/7");
    expect(unread.textContent).toContain("Unread: ");
    expect(unread.textContent).toContain("octo/api #7");
    expect(screen.getByRole("link", { name: /Checks failed/ }).textContent).not.toContain("Unread");
    await act(async () => void fireEvent.click(unread));
    expect(posted).toEqual([{ ids: ["n1"] }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  });

  it("marks all read up to the newest shown, and shows earlier ones on request", async () => {
    const newest = notice({});
    const { posted, asked } = serve([newest, notice({ id: "n2" })], "cursor 1");
    bell();
    await press(/^Notifications/);
    await screen.findByText("2 unread");
    await press("Show earlier");
    expect(asked).toContain("/api/notifications/feed?before=cursor%201");
    expect(screen.getByRole("link", { name: /Earlier/ })).toBeTruthy();
    await press("Mark all read");
    expect(posted).toEqual([{ before: newest.at }]);
    expect(screen.queryByText(/Unread: /)).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  });

  it("says what shows here when there is nothing yet", async () => {
    serve([]);
    bell();
    await press("Notifications");
    expect(await screen.findByText(/^Nothing yet\./)).toBeTruthy();
  });

  it("says so when the notices cannot be read, and tries again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "rate_limited" }, { status: 429 })),
    );
    bell();
    await press("Notifications");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load notifications",
    );
    serve([notice({})]);
    await press("Try again");
    expect(await screen.findByRole("link", { name: /Mira asked/ })).toBeTruthy();
  });

  it("shows notices in a row about the same pull request as one, and opens them as one", async () => {
    const ci = { title: "CI failed on your pull request", subtitle: "feat(web): calmer charts" };
    const { posted } = serve([
      notice({ id: "a", ...ci }),
      notice({ id: "b", ...ci }),
      notice({ id: "c", title: "ocra reviewed octo/api#7", read: true }),
    ]);
    bell();
    await press("Notifications");
    const links = await screen.findAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toContain("2 times");
    expect(links[0]?.textContent).toContain("feat(web): calmer charts");
    await act(async () => void fireEvent.click(links[0] as HTMLElement));
    expect(posted).toEqual([{ ids: ["a", "b"] }]);
  });

  it("hides read notices while Unread only is ticked, and remembers it", async () => {
    serve([notice({ id: "a" }), notice({ id: "b", title: "Already seen", read: true, pull: 8 })]);
    bell();
    await press("Notifications");
    await screen.findByRole("link", { name: /Already seen/ });
    await act(
      async () => void fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" })),
    );
    expect(screen.queryByRole("link", { name: /Already seen/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Mira asked/ })).toBeTruthy();
    expect(localStorage.getItem("ocra.feed-unread-only")).toBe("1");
    localStorage.removeItem("ocra.feed-unread-only");
  });
});
