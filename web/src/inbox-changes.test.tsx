import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PULL_VIEWS } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { Inbox } from "./pages/Inbox.js";

// The open inbox asks the server whether its pull requests changed every
// little while, and reads the platforms' listing again only when they did.

afterEach(async () => {
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
