import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, describe as suite, vi } from "vitest";
import { AUDIT_KINDS, type AuditEventView } from "../../../src/shared/index.js";
import { describe, KIND_GROUPS } from "../audit/describe.js";
import { AuditLog } from "./AuditLog.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (iso: string, e: Omit<AuditEventView, "id" | "createdAt">, id = iso) =>
  ({ id, createdAt: iso, ...e }) as AuditEventView;

suite("an audit event's line", () => {
  it("says what happened with the fields the event keeps", () => {
    const line = (e: Omit<AuditEventView, "id" | "createdAt">) => describe(at("2026-01-02", e));
    expect(line({ kind: "pull.merged", detail: { pull: "octo/api#7", method: "squash" } })).toBe(
      "Merged octo/api#7 (squash)",
    );
    expect(
      line({ kind: "pull.reviewed", detail: { pull: "octo/api#7", verdict: "approve" } }),
    ).toBe("Approved octo/api#7");
    expect(line({ kind: "budget.spend_changed", detail: { dailyUsd: 25, monthlyUsd: null } })).toBe(
      "Set the spend limit to $25.00 a day and the default a month",
    );
    expect(line({ kind: "budget.changed", detail: { dailyCalls: null } })).toBe(
      "Set the daily calls to the default",
    );
    expect(line({ kind: "session.signed_in", detail: { client: "cli", method: "device" } })).toBe(
      "Signed in from the terminal with a code approved in the browser",
    );
    expect(
      line({ kind: "merge_when_ready.failed", detail: { pull: "octo/api#7", reason: "conflict" } }),
    ).toBe("Merge when ready failed on octo/api#7: conflict");
  });

  it("reads without a field an older event did not keep", () => {
    for (const kind of AUDIT_KINDS) {
      const line = describe(at("2026-01-02", { kind, detail: {} } as never));
      expect(line, kind).not.toMatch(/undefined|null|\(\)|: $/);
      expect(line.length, kind).toBeGreaterThan(0);
    }
  });

  it("offers every kind once in the filter", () => {
    const offered = KIND_GROUPS.flatMap((g) => g.kinds.map(([kind]) => kind));
    expect([...offered].sort()).toEqual([...AUDIT_KINDS].sort());
  });
});

suite("the audit log page", () => {
  const show = (pages: (query: URLSearchParams) => unknown) => {
    const asked: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const query = new URL(url, "http://x").searchParams;
        asked.push(query);
        return Response.json(pages(query));
      }),
    );
    render(<AuditLog />);
    return asked;
  };
  const merged = at("2026-01-02T10:00:00", {
    kind: "pull.merged",
    detail: { pull: "octo/api#7", method: "squash" },
  });
  const saved = at("2026-01-02T09:00:00", {
    kind: "key.saved",
    detail: { provider: "anthropic", check: "ok" },
  });
  const older = at("2026-01-01T09:00:00", {
    kind: "session.signed_out",
    detail: { client: "web" },
  });

  it("groups events by day and loads the next page after the last", async () => {
    const asked = show((q) =>
      q.get("after") === "n1"
        ? { events: [older], next: null }
        : { events: [merged, saved], next: "n1" },
    );
    const first = await screen.findByRole("region", { name: /January 2, 2026/ });
    expect(within(first).getByText("Merged octo/api#7 (squash)")).toBeTruthy();
    expect(within(first).getByText("Saved the anthropic key: verified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    const second = await screen.findByRole("region", { name: /January 1, 2026/ });
    expect(within(second).getByText("Signed out of a browser")).toBeTruthy();
    expect(screen.getByText("Merged octo/api#7 (squash)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(asked.at(-1)?.get("after")).toBe("n1");
  });

  it("asks again from nothing for one kind and for a range", async () => {
    const asked = show((q) => ({ events: q.get("kind") ? [] : [merged], next: null }));
    await screen.findByText("Merged octo/api#7 (squash)");
    const since = Number(asked[0]?.get("since"));
    expect(Date.now() - since).toBeGreaterThan(29 * 86_400_000);
    expect(Date.now() - since).toBeLessThan(31 * 86_400_000);
    fireEvent.change(screen.getByLabelText("Kind of event"), { target: { value: "key.deleted" } });
    expect(await screen.findByText(/No such event in the last 30 days/)).toBeTruthy();
    expect(asked.at(-1)?.get("kind")).toBe("key.deleted");
    expect(asked.at(-1)?.get("after")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() =>
      expect(Date.now() - Number(asked.at(-1)?.get("since"))).toBeLessThan(8 * 86_400_000),
    );
    expect(asked.at(-1)?.get("kind")).toBe("key.deleted");
  });
});
