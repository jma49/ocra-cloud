import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeclinedLearning } from "./learnings/declined.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DATA = {
  reviewRepoId: "rr1",
  learn: "merge" as const,
  jobs: [
    { number: 7, state: "queued" as const, error: null, finishedAt: null },
    { number: 5, state: "failed" as const, error: "exit 2", finishedAt: new Date().toISOString() },
  ],
};

describe("learning from declined findings", () => {
  it("lists the pull requests being read and saves the repository's choice", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sent.push({ url, method: init?.method, body });
        return Response.json(body);
      }),
    );
    render(<DeclinedLearning platform="github" repo="octo/api" data={DATA} />);
    expect(screen.getByRole("link", { name: "#7" }).getAttribute("href")).toBe(
      "/pull/github/octo%2Fapi/7",
    );
    expect(screen.getByText("Waiting to be read")).toBeTruthy();
    expect(screen.getByText(/^Could not be read/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Learning from declined findings: Merge when checks pass",
      }),
    );
    await act(
      async () => void fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Off/ })),
    );
    expect(sent).toEqual([
      { url: "/api/auto-review/repos/rr1/learn", method: "PUT", body: { learn: "off" } },
    ]);
    expect(
      screen.getByRole("button", { name: "Learning from declined findings: Off" }),
    ).toBeTruthy();
    expect(screen.getByText("Switched off for this repository.")).toBeTruthy();
  });
});
