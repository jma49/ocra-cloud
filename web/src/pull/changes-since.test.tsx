import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullPage } from "../pages/PullPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const REVIEWED = "c".repeat(40);
const SEEN = "d".repeat(40);
const file = (path: string) => ({
  path,
  oldPath: path,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
  viewed: false,
});
const files = {
  platform: "github",
  repo: "octo/api",
  number: 7,
  title: "Cap refunds at the order total",
  author: "ada",
  url: null,
  base: "b".repeat(40),
  head: HEAD,
  updatedAt: "2026-01-02T00:00:00Z",
  state: "open",
  files: [file("src/refund.ts"), file("src/ledger.ts")],
  truncated: false,
  verdicts: ["comment"],
  mergeMethods: [],
};
const options = [
  { source: "reviewed", head: REVIEWED, at: "2026-01-01T00:00:00Z" },
  { source: "seen", head: SEEN, at: "2026-01-01T12:00:00Z" },
];
const since = (state: string, from: string | null, changed: unknown[] = []) => ({
  platform: "github",
  repo: "octo/api",
  number: 7,
  head: HEAD,
  since: from,
  state,
  options,
  files: changed,
  truncated: false,
});

function show(answer: (from: string | null) => unknown) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") return Response.json({ outcome: "done" });
      if (url.startsWith("/api/pulls/since")) {
        return Response.json(answer(new URL(url, "http://x").searchParams.get("since")));
      }
      if (url.startsWith("/api/pulls/files")) return Response.json(files);
      if (url.startsWith("/api/pulls/stack")) return Response.json({ trunk: "", pulls: [] });
      if (url.startsWith("/api/pulls/reviewers")) {
        return Response.json({ suggestions: [], owners: [] });
      }
      if (url.startsWith("/api/pulls/threads")) return Response.json({ threads: [] });
      if (url.startsWith("/api/pulls/labels")) {
        return Response.json({ applied: [], available: [], truncated: false });
      }
      if (url.startsWith("/api/pulls/draft")) return Response.json({ draft: false, state: "open" });
      return Response.json({ enabled: false, entry: null });
    }),
  );
  render(<PullPage platform="github" repo="octo/api" number="7" />);
  return asked;
}

const pick = async (name: RegExp) => fireEvent.click(await screen.findByRole("button", { name }));

describe("the changes since a head", () => {
  it("shows only what changed since the last review, without a way to comment", async () => {
    show((from) => since("changes", from ?? REVIEWED, [file("src/ledger.ts")]));
    expect(await screen.findByRole("region", { name: "src/refund.ts" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Comment on line/ }).length).toBeGreaterThan(0);
    await pick(/Since your last review · ccccccc/);
    await waitFor(() => expect(screen.queryByRole("region", { name: "src/refund.ts" })).toBeNull());
    expect(screen.getByRole("region", { name: "src/ledger.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Comment on line/ })).toBeNull();
    expect(screen.getByText("Line comments are made on the whole diff.")).toBeTruthy();
    expect(screen.queryByText(/Click a line number/)).toBeNull();
    await pick(/All changes/);
    expect(await screen.findByRole("region", { name: "src/refund.ts" })).toBeTruthy();
  });

  it("asks for the comparison before it marks the pull request seen", async () => {
    const asked = show((from) => since("same", from ?? REVIEWED));
    await waitFor(() => expect(asked).toContain("POST /api/pulls/seen"));
    const first = asked.findIndex((a) => a.startsWith("GET /api/pulls/since"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(asked.indexOf("POST /api/pulls/seen"));
  });

  it("asks again from the head of the last visit", async () => {
    const asked = show((from) => since(from === SEEN ? "same" : "changes", from ?? REVIEWED));
    await pick(/Since your last visit · ddddddd/);
    expect(await screen.findByText(/Nothing new since your last visit \(ddddddd\)/)).toBeTruthy();
    expect(asked.some((a) => a.endsWith(`&since=${SEEN}`))).toBe(true);
    expect(screen.queryByRole("region", { name: "src/refund.ts" })).toBeNull();
  });

  it("says a force push, and leads back to the whole diff", async () => {
    show((from) => since("rebased", from ?? REVIEWED));
    await pick(/Since your last review/);
    expect(await screen.findByText(/Force-pushed since your last review/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all changes" }));
    expect(await screen.findByRole("region", { name: "src/refund.ts" })).toBeTruthy();
  });

  it("falls back to the whole diff when the platform cannot compare", async () => {
    show((from) => since("unavailable", from ?? REVIEWED));
    await pick(/Since your last review/);
    expect(await screen.findByText(/could not compare/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "src/refund.ts" })).toBeTruthy();
  });

  it("offers nothing when there is no head to compare from", async () => {
    show(() => ({ ...since("none", null), options: [] }));
    expect(await screen.findByRole("region", { name: "src/refund.ts" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Changes shown" })).toBeNull();
    expect(screen.queryByRole("button", { name: /All changes/ })).toBeNull();
  });
});
