import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StackPanel } from "./pull/stack.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sha = (n: number) => String(n).repeat(40);
const stacked = (number: number, parent: number | null) => ({
  number,
  title: `Step ${number}`,
  url: `https://github.com/octo/api/pull/${number}`,
  draft: false,
  head: `step-${number}`,
  base: parent === null ? "main" : `step-${parent}`,
  headSha: sha(number),
  parent,
  checks: number === 1 ? "passing" : null,
  review: null,
});

const job = (
  step: number,
  state: string,
  reason: string | null = null,
  restacked: unknown[] = [],
) => ({
  id: "job",
  platform: "github",
  repo: "octo/api",
  bottom: 1,
  trunk: "main",
  method: "squash",
  chain: [
    { number: 1, head: sha(1) },
    { number: 2, head: sha(2) },
  ],
  step,
  state,
  reason,
  restacked,
  startedBy: "octo",
  startedAt: "2026-11-23T00:00:00.000Z",
  updatedAt: "2026-11-23T00:00:00.000Z",
  finishedAt: null,
});

function show(
  pulls: unknown[],
  answer: unknown = { outcome: "started", job: job(0, "waiting") },
  /** The stack's merge already on the server when the page loads. */
  under: unknown = null,
) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  const onMerged = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" || init?.method === "DELETE") {
        sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json(
          init.method === "DELETE" ? { outcome: "done", job: job(0, "cancelled") } : answer,
        );
      }
      if (url.startsWith("/api/pulls/merge-stack")) {
        return Response.json({ outcome: "done", job: under });
      }
      return Response.json({
        platform: "github",
        repo: "octo/api",
        number: 2,
        trunk: "main",
        pulls,
      });
    }),
  );
  render(
    <StackPanel
      pull={{ platform: "github", repo: "octo/api", number: 2 }}
      mergeMethods={["squash", "merge"]}
      onMerged={onMerged}
    />,
  );
  return { sent, onMerged };
}

const confirm = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Merge stack up to here" }));
  await act(
    async () => void fireEvent.click(screen.getByRole("button", { name: "Confirm: merge 2" })),
  );
};

describe("a pull request's stack", () => {
  it("lists the stack bottom to top, each linking to its page, this one marked", async () => {
    show([stacked(1, null), stacked(2, 1), stacked(3, 2)]);
    const links = await screen.findAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/pull/github/octo%2Fapi/1",
      "/pull/github/octo%2Fapi/2",
      "/pull/github/octo%2Fapi/3",
    ]);
    expect(links[1]?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("img", { name: "Checks pass" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Stack" })).toBeTruthy();
  });

  it("says a check failed, since one failing check is enough to set the state", async () => {
    show([{ ...stacked(1, null), checks: "failing" }, stacked(2, 1)]);
    expect(await screen.findByRole("img", { name: "A check failed" })).toBeTruthy();
  });

  it("shows nothing for a pull request that is not stacked", async () => {
    show([stacked(2, null)]);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Stack" })).toBeNull();
  });

  it("starts the merge up to this one only once confirmed, with the heads it read, and says where it waits", async () => {
    const { sent, onMerged } = show([stacked(1, null), stacked(2, 1), stacked(3, 2)], {
      outcome: "started",
      job: job(1, "waiting", "waiting_checks"),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Merge stack up to here" }));
    expect(sent).toEqual([]);
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Confirm: merge 2" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/merge-stack",
        method: "POST",
        body: {
          platform: "github",
          repo: "octo/api",
          number: 2,
          method: "squash",
          heads: [
            { number: 1, head: sha(1) },
            { number: 2, head: sha(2) },
          ],
        },
      },
    ]);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("#1Step 1Merged.");
    expect(status.textContent).toContain("#2Step 2Waiting for its checks.");
    expect(screen.getByText("Waiting").className).toBe("badge");
    expect(screen.getByRole("img", { name: "1 of 2 merged" })).toBeTruthy();
    expect(screen.getByText(/Started by octo/).textContent).toContain("runs on the server");
    expect(onMerged).toHaveBeenCalledOnce();
  });

  it("says why a merge stopped, and which pull requests above now sit on the trunk", async () => {
    show([stacked(1, null), stacked(2, 1), stacked(3, 2)], {
      outcome: "started",
      job: job(1, "failed", "checks_failed", [{ number: 3, outcome: "done" }]),
    });
    await confirm();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("#2Step 2Stopped: a check failed.");
    expect(status.textContent).toContain("#3Step 3Now onto main.");
    expect(screen.getByText("Stopped").className).toBe("badge badge-err");
    expect(screen.getByRole("img", { name: "Moved onto the trunk" })).toBeTruthy();
    expect(screen.getByText(/still hold the merged commits/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop the stack merge" })).toBeNull();
  });

  it("stops a merge under way when asked", async () => {
    const { sent, onMerged } = show([stacked(1, null), stacked(2, 1)]);
    await confirm();
    await act(
      async () =>
        void fireEvent.click(await screen.findByRole("button", { name: "Stop the stack merge" })),
    );
    expect(sent.at(-1)).toEqual({
      url: "/api/pulls/merge-stack",
      method: "DELETE",
      body: { platform: "github", repo: "octo/api", number: 1 },
    });
    expect((await screen.findByRole("status")).textContent).toContain("#1Step 1Cancelled.");
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("shows a merge already under way when the page loads, each layer leading to its page", async () => {
    show([stacked(1, null), stacked(2, 1)], undefined, job(0, "running"));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("#1Step 1Merging.");
    expect(status.textContent).toContain("#2Step 2Next.");
    expect(screen.getByText("Merging").className).toBe("badge badge-run");
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/pull/github/octo%2Fapi/1",
      "/pull/github/octo%2Fapi/2",
    ]);
    expect(screen.getByRole("button", { name: "Stop the stack merge" })).toBeTruthy();
  });

  it("leaves a merge that ended before the page loaded out of the way", async () => {
    show([stacked(1, null), stacked(2, 1)], undefined, job(0, "cancelled"));
    expect(await screen.findByRole("button", { name: "Merge stack up to here" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says the stack changed when the server would not start on what the page read", async () => {
    show([stacked(1, null), stacked(2, 1)], { outcome: "stack_changed", job: null });
    await confirm();
    expect((await screen.findByRole("alert")).textContent).toContain("The stack changed");
  });
});
