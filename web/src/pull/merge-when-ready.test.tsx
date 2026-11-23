import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergeIntentView } from "../../../src/shared/index.js";
import { MergeWhenReady } from "./merge-when-ready.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };
const armed: MergeIntentView = {
  mode: "native",
  method: "squash",
  head: HEAD,
  keepOnPush: true,
  state: "armed",
  reason: "waiting_platform",
  armedBy: "sample-user",
  armedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: null,
};

function show(first: MergeIntentView | null, outcome = "done") {
  const sent: { method: string; body: unknown }[] = [];
  let intent = first;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ intent, server: false });
      sent.push({ method: init.method, body: JSON.parse(String(init.body)) });
      if (outcome === "done") intent = init.method === "POST" ? armed : null;
      return Response.json({ outcome, intent });
    }),
  );
  render(
    <MergeWhenReady
      pull={pull}
      head={HEAD}
      method="merge"
      label={{ squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" }}
    />,
  );
  return sent;
}

describe("merge when ready", () => {
  it("arms the head it read with the method and whether it survives a push", async () => {
    const sent = show(null);
    fireEvent.click(await screen.findByLabelText("Keep armed on new commits"));
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Merge when ready" })),
    );
    expect(sent).toEqual([
      { method: "POST", body: { ...pull, method: "merge", head: HEAD, keepOnPush: true } },
    ]);
    expect(await screen.findByText("Armed")).toBeTruthy();
  });

  it("says who armed it, how and what it waits for, and cancels it", async () => {
    const sent = show(armed);
    expect(
      await screen.findByText("Squash and merge, set by sample-user 5m ago, kept on new commits."),
    ).toBeTruthy();
    expect(
      screen.getByText("Waiting for required checks, approvals or a clean merge."),
    ).toBeTruthy();
    await act(
      async () =>
        void fireEvent.click(screen.getByRole("button", { name: "Cancel merge when ready" })),
    );
    expect(sent).toEqual([{ method: "DELETE", body: pull }]);
    expect(await screen.findByRole("button", { name: "Merge when ready" })).toBeTruthy();
  });

  it("says why a repository cannot be armed", async () => {
    show(null, "unavailable");
    await act(
      async () =>
        void fireEvent.click(await screen.findByRole("button", { name: "Merge when ready" })),
    );
    expect(await screen.findByText(/Auto-merge is off for this repository/)).toBeTruthy();
  });
});
