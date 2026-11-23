import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PULL_VIEWS } from "../../src/shared/index.js";
import { clearCache } from "./cache.js";
import { Inbox } from "./pages/Inbox.js";

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  await clearCache();
});

const answer = {
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
          title: "Change 1",
          url: "https://github.com/octo/api/pull/1",
          repo: "octo/api",
          author: "octo",
          authorAvatar: null,
          draft: true,
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
};

it("says how old the list is when a refresh fails, on top, with a way to try again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let up = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/pull-views")
        return Response.json({ views: [], defaults: DEFAULT_PULL_VIEWS });
      return up ? Response.json(answer) : Response.json({ error: "internal" }, { status: 500 });
    }),
  );
  const first = render(<Inbox />);
  await waitFor(() => expect(screen.getByText("Change 1")).toBeTruthy());
  expect(screen.queryByText(/This list was read/)).toBeNull();
  first.unmount();

  up = false;
  vi.setSystemTime(Date.now() + 31 * 60_000);
  render(<Inbox />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/Could not refresh: .*This list was read 31m ago\./);
  expect(screen.getByText("Change 1")).toBeTruthy();

  up = true;
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
