import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RestackJobView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { StackPanel } from "./stack.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await clearCache();
});

const sha = (n: number) => String(n).repeat(40);
const layer = (number: number, parent: number | null, behind: number | null) => ({
  number,
  title: `Step ${number}`,
  url: `https://github.com/octo/api/pull/${number}`,
  draft: false,
  head: `step-${number}`,
  base: parent === null ? "main" : `step-${parent}`,
  headSha: sha(number),
  parent,
  behind,
  checks: null,
  review: null,
});

const job = (over: Partial<RestackJobView>): RestackJobView => ({
  id: "j1",
  number: 2,
  parent: 1,
  branch: "step-2",
  onto: "step-1",
  from: sha(2),
  to: null,
  state: "queued",
  outcome: null,
  reason: null,
  askedBy: "octo",
  createdAt: "2026-11-23T00:00:00.000Z",
  finishedAt: null,
  ...over,
});

/** The panel of #2, two commits behind #1, with what the server says of its restacks. */
function show(restack: { offered: boolean; job: RestackJobView | null }, answer?: unknown) {
  const state = { ...restack };
  const sent: unknown[] = [];
  const onMerged = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/pulls/restack")) {
        if (init?.method !== "POST") return Response.json(state);
        sent.push(JSON.parse(String(init.body)));
        return Response.json(answer);
      }
      if (url.startsWith("/api/pulls/merge-stack")) {
        return Response.json({ outcome: "done", job: null });
      }
      return Response.json({
        platform: "github",
        repo: "octo/api",
        number: 2,
        trunk: "main",
        pulls: [layer(1, null, null), layer(2, 1, 2)],
      });
    }),
  );
  render(
    <StackPanel
      pull={{ platform: "github", repo: "octo/api", number: 2 }}
      mergeMethods={[]}
      onMerged={onMerged}
      restack={<button type="button">Update branch</button>}
    />,
  );
  return { state, sent, onMerged };
}

describe("a layer behind the one it is stacked on", () => {
  it("offers the merge and the local restack where ocra does not restack", async () => {
    show({ offered: false, job: null });
    await screen.findByText(/This branch lacks 2 commits of #1/);
    expect(screen.getByRole("button", { name: "Update branch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restack" })).toBeNull();
  });

  it("asks ocra for a restack with the heads the page read, and says it is queued", async () => {
    const queued = job({});
    const { state, sent } = show(
      { offered: true, job: null },
      { outcome: "queued", offered: true, job: queued },
    );
    const button = await screen.findByRole("button", { name: "Restack" });
    expect(screen.queryByRole("button", { name: "Update branch" })).toBeNull();
    state.job = queued;
    await act(async () => void fireEvent.click(button));
    expect(sent).toEqual([
      { platform: "github", repo: "octo/api", number: 2, head: sha(2), parentHead: sha(1) },
    ]);
    expect((await screen.findByRole("status")).textContent).toBe("Restack queued");
    expect(screen.queryByRole("button", { name: "Restack" })).toBeNull();
  });

  it("reads the page again once the restack it watched pushed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state, onMerged } = show({ offered: true, job: job({ state: "running" }) });
    expect((await screen.findByRole("status")).textContent).toBe("Restacking");
    state.job = job({ state: "done", outcome: "restacked", to: sha(9) });
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_100)));
    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it("says why a restack left the branch, and offers another", async () => {
    show({ offered: true, job: job({ state: "done", outcome: "conflict" }) });
    expect(await screen.findByRole("button", { name: "Restack again" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "ocra could not restack it: the rebase conflicts, so nothing was pushed.",
    );
  });

  it("says nothing of a restack of an older head", async () => {
    show({ offered: true, job: job({ state: "done", outcome: "conflict", from: sha(7) }) });
    expect(await screen.findByRole("button", { name: "Restack" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says the stack changed when a head moved, and queues nothing", async () => {
    show({ offered: true, job: null }, { outcome: "stack_changed", offered: true, job: null });
    const button = await screen.findByRole("button", { name: "Restack" });
    await act(async () => void fireEvent.click(button));
    expect(screen.getByRole("status").textContent).toBe(
      "The stack changed since this page loaded. Reload to see it.",
    );
  });
});
