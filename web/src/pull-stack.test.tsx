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

function show(pulls: unknown[], steps: unknown[] = []) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ steps });
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
    />,
  );
  return sent;
}

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

  it("shows nothing for a pull request that is not stacked", async () => {
    show([stacked(2, null)]);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Stack" })).toBeNull();
  });

  it("merges up to this one only once confirmed, with the heads it read, and says how each went", async () => {
    const sent = show(
      [stacked(1, null), stacked(2, 1), stacked(3, 2)],
      [
        { number: 1, outcome: "done" },
        { number: 2, outcome: "not_mergeable" },
      ],
    );
    fireEvent.click(await screen.findByRole("button", { name: "Merge stack up to here" }));
    expect(sent).toEqual([]);
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Confirm: merge 2" })),
    );
    expect(sent).toEqual([
      {
        url: "/api/pulls/merge-stack",
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
    expect(status.textContent).toContain("#1 Done.");
    expect(status.textContent).toContain("#2 The platform says it cannot be merged");
  });
});
