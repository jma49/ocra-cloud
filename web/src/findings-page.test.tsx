import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Findings } from "./pages/Findings.js";
import { ToastProvider } from "./toast.js";
import { forgetProviders } from "./ui.js";

afterEach(() => {
  forgetProviders();
  cleanup();
  vi.unstubAllGlobals();
});

const row = {
  id: "f1",
  reviewId: "r1",
  repoHash: "h",
  repo: "h",
  name: "octo/api",
  prNumber: 12,
  reviewer: "correctness",
  severity: "warning",
  category: "correctness",
  verification: "verified",
  file: "src/app.ts",
  lineStart: 4,
  lineEnd: 4,
  title: "Retry count can go negative",
  status: "open",
  reason: null,
  note: null,
  decidedAt: null,
  createdAt: "2026-11-23T00:00:00.000Z",
};

describe("the findings list", () => {
  it("names a category the reviewer is named after once, and the pull request it came from", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          findings: [row, { ...row, id: "f2", prNumber: null, category: "security" }],
          next: null,
          statuses: { open: 2, fixed: 0, dismissed: 0 },
        }),
      ),
    );
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    const [first, second] = await screen.findAllByRole("row").then((rows) => rows.slice(1));
    expect(first?.textContent).toContain("src/app.ts:4 · correctness · verified");
    expect(first?.textContent).toContain("octo/api #12");
    expect(second?.textContent).toContain("correctness · security · verified");
    expect(second?.textContent).not.toContain("#");
  });

  it("says where each finding stands in the page's words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          findings: [
            { ...row, status: "merged" },
            { ...row, id: "f2", status: "addressed" },
          ],
          next: null,
          statuses: { open: 0, fixed: 0, dismissed: 0, addressed: 1, merged: 1 },
        }),
      ),
    );
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    const [first, second] = await screen.findAllByRole("row").then((rows) => rows.slice(1));
    expect(first?.querySelector(".status-warn")?.textContent).toBe("Merged unaddressed");
    expect(second?.querySelector(".status-quiet")?.textContent).toBe("Addressed");
    expect(screen.getByText("Merged unaddressed (1)")).toBeTruthy();
  });
});
