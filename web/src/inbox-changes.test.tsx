import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PULL_VIEWS } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { Inbox } from "./pages/Inbox.js";

// The open inbox hears from the server when its pull requests changed (a
// stream of changes, or, without one, asking every little while), and
// reads the platforms' listing again only when they did.

class FakeSource {
  static all: FakeSource[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(kind: string, fn: () => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), fn]);
  }
  emit(kind: string) {
    for (const fn of this.listeners.get(kind) ?? []) fn();
  }
  close() {
    this.closed = true;
  }
}

afterEach(async () => {
  FakeSource.all = [];
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  await clearCache();
});

const listing = (changedAt: string | null, title: string) => ({
  changedAt,
  platforms: [
    {
      platform: "github",
      host: "github.com",
      linked: true,
      failed: false,
      more: false,
      pulls: [
        {
          id: "1",
          number: 1,
          title,
          url: "https://github.com/octo/api/pull/1",
          repo: "octo/api",
          author: "octo",
          authorAvatar: null,
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
          head: null,
          unread: false,
          repliesWaiting: 0,
        },
      ],
    },
  ],
});

it("reads the listing again only when the server's change time moved past it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let changedAt = "2026-11-21T10:00:00.000Z";
  let title = "Change 1";
  const listings: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/pull-views") {
        return Response.json({ views: [], defaults: DEFAULT_PULL_VIEWS });
      }
      if (url === "/api/platforms/pulls/changed") return Response.json({ changedAt });
      listings.push(url);
      return Response.json(listing(changedAt, title));
    }),
  );
  render(<Inbox />);
  await waitFor(() => expect(screen.getAllByText("Change 1").length).toBeGreaterThan(0));
  const read = listings.length;

  await act(async () => void vi.advanceTimersByTime(30_000));
  expect(listings.length).toBe(read);

  changedAt = "2026-11-21T10:05:00.000Z";
  title = "Change 1, reworded";
  await act(async () => void vi.advanceTimersByTime(30_000));
  await waitFor(() => expect(screen.getAllByText("Change 1, reworded").length).toBeGreaterThan(0));
  expect(listings.length).toBe(read + 1);

  await act(async () => void vi.advanceTimersByTime(30_000));
  expect(listings.length).toBe(read + 1);
});

/** The inbox over a server whose change time is `state.changedAt`; what it asked, by kind. */
function serve(state: { changedAt: string; title: string }) {
  const asked = { listings: 0, changes: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/pull-views") {
        return Response.json({ views: [], defaults: DEFAULT_PULL_VIEWS });
      }
      if (url === "/api/platforms/pulls/changed") {
        asked.changes++;
        return Response.json({ changedAt: state.changedAt });
      }
      asked.listings++;
      return Response.json(listing(state.changedAt, state.title));
    }),
  );
  return asked;
}

it("reads the listing again when the stream says a pull request changed, and polls none while it is open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("EventSource", FakeSource);
  const state = { changedAt: "2026-11-21T10:00:00.000Z", title: "Change 1" };
  const asked = serve(state);
  render(<Inbox />);
  await vi.waitFor(() => expect(screen.getAllByText("Change 1").length).toBeGreaterThan(0));
  const source = FakeSource.all[0];
  expect(source?.url).toBe("/api/platforms/pulls/changed/stream");
  await act(async () => source?.emit("ready"));
  await vi.waitFor(() => expect(asked.changes).toBe(1));
  const read = asked.listings;

  await act(async () => void vi.advanceTimersByTime(120_000));
  expect([asked.changes, asked.listings]).toEqual([1, read]);

  state.changedAt = "2026-11-21T10:05:00.000Z";
  state.title = "Change 1, reworded";
  await act(async () => {
    source?.emit("pulls");
    source?.emit("pulls");
  });
  await act(async () => void vi.advanceTimersByTime(1_000));
  await vi.waitFor(() =>
    expect(screen.getAllByText("Change 1, reworded").length).toBeGreaterThan(0),
  );
  expect([asked.changes, asked.listings]).toEqual([2, read + 1]);
});

it("asks every 30 s again while the stream is down", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("EventSource", FakeSource);
  const asked = serve({ changedAt: "2026-11-21T10:00:00.000Z", title: "Change 1" });
  render(<Inbox />);
  await waitFor(() => expect(screen.getAllByText("Change 1").length).toBeGreaterThan(0));
  const source = FakeSource.all[0];
  await act(async () => source?.emit("ready"));
  await waitFor(() => expect(asked.changes).toBe(1));
  await act(async () => source?.emit("error"));
  await act(async () => void vi.advanceTimersByTime(30_000));
  await waitFor(() => expect(asked.changes).toBe(2));
});
