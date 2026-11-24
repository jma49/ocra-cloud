import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFor, clearCache, useCached } from "./cache.js";
import { decided } from "./pages/Findings.js";

afterEach(async () => {
  cleanup();
  await clearCache();
});

const later = <T,>() => {
  let finish: (v: T) => void = () => {};
  const p = new Promise<T>((r) => (finish = r));
  return { p, finish };
};

describe("useCached", () => {
  it("opens on the last answer for its key, then shows the fresh one", async () => {
    const first = renderHook(() => useCached("k", async () => "old"));
    await waitFor(() => expect(first.result.current.data).toBe("old"));
    first.unmount();

    const fresh = later<string>();
    const { result } = renderHook(() => useCached("k", () => fresh.p));
    expect(result.current).toMatchObject({ data: "old", stale: true, loading: false });
    await act(async () => fresh.finish("new"));
    expect(result.current).toMatchObject({ data: "new", stale: false });
  });

  it("never shows another key's answer while a new key loads", async () => {
    const pending = later<string>();
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useCached(key, () => (key === "a" ? Promise.resolve("A") : pending.p)),
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(result.current.data).toBe("A"));
    rerender({ key: "b" });
    expect(result.current).toMatchObject({ data: undefined, loading: true });
    await act(async () => pending.finish("B"));
    expect(result.current.data).toBe("B");
  });

  it("shows an edit at once, undoes it, and drops an answer asked before it", async () => {
    let answer = Promise.resolve(1);
    const { result } = renderHook(() => useCached("n", () => answer));
    await waitFor(() => expect(result.current.data).toBe(1));

    const slow = later<number>();
    answer = slow.p;
    act(() => result.current.reload());
    let undo = () => {};
    act(() => {
      undo = result.current.change((n) => n + 10);
    });
    expect(result.current.data).toBe(11);
    await act(async () => slow.finish(1));
    expect(result.current.data).toBe(11);
    act(() => undo());
    expect(result.current.data).toBe(1);
  });

  it("forgets everything when another account signs in", async () => {
    await cacheFor("ada");
    const first = renderHook(() => useCached("k", async () => "ada's"));
    await waitFor(() => expect(first.result.current.data).toBe("ada's"));
    first.unmount();
    await cacheFor("grace");
    const { result } = renderHook(() => useCached("k", () => new Promise<string>(() => {})));
    expect(result.current).toMatchObject({ data: undefined, loading: true });
  });
});

describe("a finding decision shown before the server answers", () => {
  const row = (id: string, status: "open" | "fixed" | "dismissed") => ({
    id,
    reviewId: "r",
    repoHash: "h",
    repo: "github.com/a/b",
    name: null,
    reviewer: "bugs",
    severity: "warning" as const,
    category: null,
    verification: null,
    file: "a.ts",
    lineStart: 1,
    lineEnd: 1,
    title: id,
    status,
    reason: null,
    note: null,
    decidedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
  });
  const page = {
    findings: [row("x", "open"), row("y", "open")],
    next: null,
    statuses: { open: 2, fixed: 0, dismissed: 0, addressed: 0, merged: 0 },
  };

  it("takes rows out of a status they left and moves the counts", () => {
    const p = decided(page, new Set(["x"]), "open", {
      status: "dismissed",
      reason: "not_important",
    });
    expect(p.findings.map((f) => f.id)).toEqual(["y"]);
    expect(p.statuses).toEqual({ open: 1, fixed: 0, dismissed: 1, addressed: 0, merged: 0 });
  });

  it("changes rows in place under All", () => {
    const p = decided(page, new Set(["x"]), "all", {
      status: "dismissed",
      reason: "wrong_fix",
      note: "n",
    });
    expect(p.findings[0]).toMatchObject({
      id: "x",
      status: "dismissed",
      reason: "wrong_fix",
      note: "n",
    });
    expect(p.findings).toHaveLength(2);
  });

  it("leaves a row already in that status alone", () => {
    const p = decided(page, new Set(["x"]), "open", { status: "open" });
    expect(p).toEqual({ ...page, findings: page.findings, statuses: page.statuses });
  });
});
