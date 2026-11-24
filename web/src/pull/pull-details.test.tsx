import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditTitle, OpenClose } from "./pull-details.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = { platform: "gitlab", repo: "group/project", number: 3 };

const sentBody = (fetch: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
};

it("sends the new title with the one the page read", async () => {
  const fetch = vi.fn(async () => Response.json({ outcome: "done" }));
  vi.stubGlobal("fetch", fetch);
  const onDone = vi.fn();
  render(<EditTitle pull={pull} title="Fix the cache" onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "Fix it" } });
  fireEvent.click(screen.getByRole("button", { name: "Save title" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("done"));
  expect(sentBody(fetch)).toEqual({
    url: "/api/pulls/details",
    body: { ...pull, title: { from: "Fix the cache", to: "Fix it" } },
  });
});

it("says a title someone changed since was not overwritten", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "stale" }, { status: 409 })),
  );
  render(<EditTitle pull={pull} title="Fix the cache" onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "Fix it" } });
  fireEvent.click(screen.getByRole("button", { name: "Save title" }));
  expect((await screen.findByRole("alert")).textContent).toContain("someone changed it");
});

it("closes an open pull request and reopens a closed one", async () => {
  const fetch = vi.fn(async () => Response.json({ outcome: "done" }));
  vi.stubGlobal("fetch", fetch);
  const onDone = vi.fn();
  const { rerender } = render(<OpenClose pull={pull} state="open" onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: "Close pull request" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("done"));
  expect(sentBody(fetch)).toEqual({ url: "/api/pulls/state", body: { ...pull, state: "closed" } });
  rerender(<OpenClose pull={pull} state="closed" onDone={onDone} />);
  expect(screen.getByRole("button", { name: "Reopen pull request" })).toBeTruthy();
});
