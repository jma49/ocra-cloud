import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BATCH_ITEMS, type PullBatchView } from "../../../src/shared/index.js";
import { BatchPick, PullBatch } from "./batch.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = { platform: "github", repo: "octo/api", number: 7 };

/** Answers a batch with `view`, or refuses it, and keeps what was sent. */
function serve(view: PullBatchView | null) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== "/api/pulls/apply-batch")
        return Response.json({ error: "not_found" }, { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      return view ? Response.json(view) : Response.json({ error: "rate_limited" }, { status: 429 });
    }),
  );
  return sent;
}

function page(n = 2) {
  const done: string[] = [];
  render(
    <PullBatch pull={pull} head="abc123" onCommitted={() => done.push("committed")}>
      <BatchPick pick={{ kind: "finding", id: "f1", label: "Unchecked index" }}>Fix</BatchPick>
      {Array.from({ length: n - 1 }, (_, i) => (
        <BatchPick
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          key={i}
          pick={{ kind: "suggestion", id: `s${i + 1}`, label: `Suggestion ${i + 1}` }}
        >
          Suggestion {i + 1}
        </BatchPick>
      ))}
    </PullBatch>,
  );
  return done;
}

const tick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name }));
const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("committing chosen changes together", () => {
  it("shows no bar until something is chosen, and none again once cleared", async () => {
    serve(null);
    page();
    expect(screen.queryByRole("region", { name: "Commit together" })).toBeNull();
    tick("Fix");
    expect(screen.getByText("1 chosen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit 1 change" })).toBeTruthy();
    await press("Clear");
    expect(screen.queryByRole("region", { name: "Commit together" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Fix" }) as HTMLInputElement).checked).toBe(false);
  });

  it("sends the choice in the order it was made, for the head the page read", async () => {
    const sent = serve({
      outcome: "done",
      items: [
        { kind: "suggestion", id: "s1", applied: true, reason: null },
        { kind: "finding", id: "f1", applied: false, reason: "conflict" },
      ],
    });
    const done = page();
    tick("Suggestion 1");
    tick("Fix");
    await press("Commit 2 as one commit");
    expect(sent).toEqual([
      {
        ...pull,
        head: "abc123",
        items: [
          { kind: "suggestion", id: "s1" },
          { kind: "finding", id: "f1" },
        ],
      },
    ]);
    expect(done).toEqual(["committed"]);
    expect(screen.getByRole("status").textContent).toBe("Committed 1 of 2 changes as one commit.");
    expect(screen.getByText("Unchecked index")).toBeTruthy();
    expect(screen.getByText(/changes the same lines differently/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Commit/ })).toBeNull();
    await press("Dismiss");
    expect(screen.queryByRole("region", { name: "Commit together" })).toBeNull();
  });

  it("keeps the choice when nothing was committed, and says why each was left out", async () => {
    serve({
      outcome: "not_applicable",
      items: [
        { kind: "finding", id: "f1", applied: false, reason: "stale" },
        { kind: "suggestion", id: "s1", applied: false, reason: "not_found" },
      ],
    });
    const done = page();
    tick("Fix");
    tick("Suggestion 1");
    await press("Commit 2 as one commit");
    expect(done).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe(
      "None of them could be applied, so nothing was committed.",
    );
    expect(screen.getByText(/older head/)).toBeTruthy();
    expect(screen.getByText(/no longer on this pull request/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit 2 as one commit" })).toBeTruthy();
  });

  it("lists no item when the head moved: none was looked at", async () => {
    serve({
      outcome: "head_moved",
      items: [{ kind: "finding", id: "f1", applied: false, reason: "not_sent" }],
    });
    page();
    tick("Fix");
    await press("Commit 1 change");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("status").textContent).not.toBe("");
  });

  it("says so when the server refuses, and keeps the choice", async () => {
    serve(null);
    const done = page();
    tick("Fix");
    await press("Commit 1 change");
    expect(screen.getByRole("alert").textContent).toMatch(/^Could not commit them: /);
    expect(done).toEqual([]);
    expect(screen.getByText("1 chosen")).toBeTruthy();
  });

  it("takes no more than one commit holds, but lets a chosen one go", () => {
    serve(null);
    page(MAX_BATCH_ITEMS + 1);
    tick("Fix");
    for (let i = 1; i < MAX_BATCH_ITEMS; i++) tick(`Suggestion ${i}`);
    const extra = screen.getByRole("checkbox", {
      name: `Suggestion ${MAX_BATCH_ITEMS}`,
    }) as HTMLInputElement;
    expect(extra.disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Fix" }) as HTMLInputElement).disabled).toBe(
      false,
    );
    tick("Fix");
    expect(extra.disabled).toBe(false);
  });

  it("offers no checkbox on a page without a batch", () => {
    const { container } = render(
      <BatchPick pick={{ kind: "finding", id: "f1", label: "x" }}>Fix</BatchPick>,
    );
    expect(container.textContent).toBe("");
  });
});
