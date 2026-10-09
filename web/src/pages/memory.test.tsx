import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Memory } from "./Memory.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entry = (id: string) => ({
  id,
  repo: "8d969eef",
  fingerprint: `fp-${id}`,
  file: "src/db.ts",
  title: `Finding ${id}`,
  reason: "Accepted.",
  createdAt: "2026-10-04T12:00:00.000Z",
});

function fakeMemory(answer: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(answer)),
  );
}

describe("the memory page (#96)", () => {
  it("says it shows only the newest entries when the account has more", async () => {
    fakeMemory({ entries: [entry("a"), entry("b")], total: 7 });
    render(<Memory />);
    expect(await screen.findByText("Finding a")).toBeTruthy();
    expect(screen.getByText(/Showing the newest 2 of 7/)).toBeTruthy();
  });

  it("says nothing of the kind when every entry is listed", async () => {
    fakeMemory({ entries: [entry("a")], total: 1 });
    render(<Memory />);
    expect(await screen.findByText("Finding a")).toBeTruthy();
    expect(screen.queryByText(/Showing the newest/)).toBeNull();
  });
});
