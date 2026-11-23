import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { ToastProvider } from "../toast.js";
import { Findings } from "./Findings.js";
import { ReviewDetail } from "./ReviewDetail.js";

// The findings list and a review's timeline, read and decided by key.

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const press = (key: string) => fireEvent.keyDown(document.body, { key });
const rowOf = (text: string) => screen.getByText(text).closest("[data-row]") as HTMLElement;

const finding = (id: string, title: string) => ({
  id,
  reviewId: "r1",
  repoHash: "abcd1234",
  repo: "abcd1234",
  name: "octo/api",
  reviewer: "correctness",
  severity: "warning",
  category: null,
  verification: null,
  file: "src/a.ts",
  lineStart: 3,
  lineEnd: 3,
  title,
  status: "open",
  reason: null,
  note: null,
  decidedAt: null,
  createdAt: new Date().toISOString(),
  // The review's own view of a finding carries these too.
  fingerprint: id,
  body: `Why ${title} matters.`,
  suggestion: null,
  code: null,
  redacted: false,
  truncated: false,
  fix: null,
  issue: null,
});

describe("the findings list's keys", () => {
  it("move a current row, select it, and mark it fixed", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url === "/api/findings/decide"
        ? Response.json({ changed: 1, remembered: 0, body: init?.body })
        : Response.json({
            findings: [finding("f1", "First"), finding("f2", "Second")],
            next: null,
            statuses: { open: 2, fixed: 0, dismissed: 0 },
          }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<Findings />);
    await screen.findByText("First");
    expect(rowOf("First").className).not.toContain("is-current");

    press("j");
    expect(rowOf("First").className).toContain("is-current");
    press("j");
    expect(rowOf("Second").className).toContain("is-current");
    press("x");
    expect(screen.getByRole("checkbox", { name: "Select Second" })).toHaveProperty("checked", true);

    press("f");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/findings/decide", expect.anything()),
    );
    const sent = fetch.mock.calls.find(([u]) => u === "/api/findings/decide")?.[1]?.body;
    expect(JSON.parse(String(sent))).toEqual({ ids: ["f2"], status: "fixed" });
  });

  it("says what a decision changed and undoes it by reopening the same findings", async () => {
    const fetch = vi.fn(async (url: string) =>
      url === "/api/findings/decide"
        ? Response.json({ changed: 1, remembered: 0 })
        : Response.json({
            findings: [finding("f1", "First")],
            next: null,
            statuses: { open: 1, fixed: 0, dismissed: 0 },
          }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ToastProvider>
        <Findings />
      </ToastProvider>,
    );
    await screen.findByText("First");
    press("j");
    press("f");
    expect(await screen.findByText("1 marked fixed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([u]) => u === "/api/findings/decide")).toHaveLength(2),
    );
    const undo = fetch.mock.calls.filter(([u]) => u === "/api/findings/decide")[1]?.[1]?.body;
    expect(JSON.parse(String(undo))).toEqual({ ids: ["f1"], status: "open" });
  });
});

describe("a review's keys", () => {
  it("move between findings and show the current one's details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/reviews/r1"
          ? Response.json({
              review: {
                id: "r1",
                runId: "run",
                repo: "abcd1234",
                source: "local",
                verdict: "comment",
                complete: true,
                critical: 0,
                warning: 2,
                suggestion: 0,
                createdAt: new Date().toISOString(),
                prRepository: null,
                prNumber: null,
                linkedTasks: null,
                learnings: null,
              },
              findings: [finding("f1", "First"), finding("f2", "Second")],
              walkthrough: null,
            })
          : Response.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    render(<ReviewDetail id="r1" graphs={false} />);
    await screen.findByText("First");
    press("j");
    press("j");
    expect(rowOf("Second").className).toContain("is-current");
    expect(screen.queryByText("Why Second matters.")).toBeNull();
    press("d");
    expect(screen.getByText("Why Second matters.")).toBeTruthy();
    press("k");
    expect(rowOf("First").className).toContain("is-current");
  });
});
