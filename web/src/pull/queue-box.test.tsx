import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MergeQueueView } from "../../../src/shared/index.js";
import { QueueBox } from "./queue-box.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 } as const;
const out: MergeQueueView = { enabled: true, entry: null, ahead: [], size: 0, removed: null };
const queued: MergeQueueView = {
  enabled: true,
  entry: { state: "checking", position: 3, enqueuedAt: null, enqueuedBy: null, estimate: 600 },
  ahead: [{ number: 4, title: "Step 4", state: "ready" }],
  size: 5,
  removed: null,
};

function show(view: MergeQueueView, primary = false, unmet = false) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ outcome: "done" });
    }),
  );
  const calls = { onDone: vi.fn(), reload: vi.fn(), onLeft: vi.fn() };
  const box = (v: MergeQueueView) => (
    <QueueBox view={v} pull={pull} head={HEAD} primary={primary} unmet={unmet} {...calls} />
  );
  const { rerender } = render(box(view));
  return { sent, ...calls, to: (v: MergeQueueView) => rerender(box(v)) };
}

it("shows a queued pull request's place, what merges before it, and takes it out", async () => {
  const { sent, onDone, reload, onLeft, to } = show(queued);
  expect(screen.getByText("3rd of 5 · merges in about 10m")).toBeTruthy();
  expect(screen.getByText("Checks running").className).toBe("badge badge-run");
  expect(screen.getByRole("link", { name: /Step 4/ }).getAttribute("href")).toBe(
    "/pull/github/octo%2Fapi/4",
  );
  expect(screen.getByText("Next to merge")).toBeTruthy();
  await act(
    async () => void fireEvent.click(screen.getByRole("button", { name: "Remove from queue" })),
  );
  expect(sent).toEqual([{ url: "/api/pulls/dequeue", body: pull }]);
  expect(onDone).toHaveBeenCalledWith("done");
  expect(reload).toHaveBeenCalledOnce();
  to(out);
  expect(onLeft).not.toHaveBeenCalled();
});

it("reads the queue again while the pull request is in it, and tells the page when it left on its own", () => {
  vi.useFakeTimers();
  const { reload, onLeft, to } = show(queued);
  vi.advanceTimersByTime(10_000);
  expect(reload).toHaveBeenCalledOnce();
  to(out);
  expect(onLeft).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  expect(reload).toHaveBeenCalledOnce();
});

it("says why the pull request left the queue and offers to add it again", () => {
  show({ ...out, removed: { at: new Date().toISOString(), by: null, reason: "CI checks failed" } });
  expect(screen.getByRole("status").textContent).toBe("Left the queue just now: CI checks failed.");
  expect(screen.getByRole("button", { name: "Add to merge queue again" })).toBeTruthy();
});

it("sends the head the page read, as the primary button only once queueing is the next step", async () => {
  const add = () => screen.getByRole("button", { name: "Add to merge queue" });
  show(out, false);
  const quiet = add().className;
  cleanup();
  const { sent } = show(out, true);
  expect(add().className).not.toBe(quiet);
  await act(async () => void fireEvent.click(add()));
  expect(sent).toEqual([{ url: "/api/pulls/enqueue", body: { ...pull, head: HEAD } }]);
});

it("says the queue takes it once its requirements are met, while one is known not to be", () => {
  show(out);
  expect(screen.queryByText(/once what Merge readiness lists is met/)).toBeNull();
  cleanup();
  show(out, false, true);
  expect(screen.getByText(/once what Merge readiness lists is met/)).toBeTruthy();
  cleanup();
  show(queued, false, true);
  expect(screen.queryByText(/once what Merge readiness lists is met/)).toBeNull();
});
