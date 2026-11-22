import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixProposalView } from "../../src/shared/index.js";
import { FixDiff } from "./fixes/fix-diff.js";
import { PullPage } from "./pages/PullPage.js";
import { parsePatch, placeOnLines } from "./pull/diff.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const PATCH = [
  "@@ -10,3 +10,3 @@ export function refund(",
  " const left = charge.captured;",
  "-if (amount > charge.amount) {",
  "+if (amount > left) {",
  "   throw new RefundTooLarge(amount);",
].join("\n");

const fix = (over: Partial<FixProposalView> = {}): FixProposalView => ({
  finding: "f1",
  title: "Refund can exceed what was captured",
  severity: "critical",
  file: "src/refund.ts",
  startLine: 11,
  endLine: 11,
  before: ["if (amount > left) {"],
  after: ["if (amount > left || amount <= 0) {"],
  ...over,
});

describe("where a fix sits on a diff", () => {
  it("goes under the new line its range ends on, or at the top when the diff does not show it", () => {
    const placed = placeOnLines(parsePatch(PATCH), [fix(), fix({ finding: "f2", endLine: 40 })]);
    expect(placed.get(3)?.map((f) => f.finding)).toEqual(["f1"]);
    expect(placed.get(-1)?.map((f) => f.finding)).toEqual(["f2"]);
  });
});

describe("a fix's diff", () => {
  it("shows the lines it replaces at their numbers, then what it writes", () => {
    render(<FixDiff fix={fix({ startLine: 7, endLine: 8, before: ["a", "b"], after: ["c"] })} />);
    const rows = screen.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual(["7−a", "8−b", "7+c"]);
  });

  it("names the lines it replaces when they could not be read, and says when it deletes them", () => {
    render(<FixDiff fix={fix({ startLine: 3, endLine: 5, before: null, after: [] })} />);
    const rows = screen.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual(["Replaces lines 3–5", "Deletes these lines"]);
  });
});

describe("a fix on the pull request's page", () => {
  it("sits under its line and, committed, reads the pull request again", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          sent.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ outcome: "done" });
        }
        reads.push(url);
        if (url.startsWith("/api/pulls/fixes")) {
          return Response.json({ review: { id: "r1", head: HEAD }, fixes: [fix()] });
        }
        if (url.startsWith("/api/pulls/stack")) return Response.json({ trunk: "", pulls: [] });
        if (url.startsWith("/api/pulls/labels")) {
          return Response.json({ applied: [], available: [], truncated: false });
        }
        if (url.startsWith("/api/pulls/draft")) {
          return Response.json({ draft: false, state: "open" });
        }
        if (url.startsWith("/api/pulls/reviewers")) {
          return Response.json({ suggestions: [], owners: [] });
        }
        if (url.startsWith("/api/pulls/threads")) {
          return Response.json({ head: HEAD, truncated: false, threads: [] });
        }
        if (url.startsWith("/api/pulls/queue"))
          return Response.json({ enabled: false, entry: null });
        return Response.json({
          platform: "github",
          repo: "octo/api",
          number: 7,
          title: "Cap refunds",
          author: null,
          url: null,
          state: "open",
          base: "b".repeat(40),
          head: HEAD,
          updatedAt: null,
          files: [
            {
              path: "src/refund.ts",
              oldPath: "src/refund.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: PATCH,
              viewed: false,
            },
          ],
          truncated: false,
          verdicts: ["comment"],
          mergeMethods: [],
        });
      }),
    );
    render(<PullPage platform="github" repo="octo/api" number="7" />);
    const card = await screen.findByLabelText("ocra's fix: Refund can exceed what was captured");
    expect(within(card).getByText("if (amount > left || amount <= 0) {")).toBeTruthy();
    expect(reads).toContain(
      `/api/pulls/fixes?platform=github&repo=octo%2Fapi&number=7&head=${HEAD}`,
    );
    const before = reads.filter((u) => u.startsWith("/api/pulls/files")).length;
    await act(
      async () => void fireEvent.click(within(card).getByRole("button", { name: "Commit fix" })),
    );
    expect(sent).toEqual([{ url: "/api/pulls/apply-fix", body: { finding: "f1" } }]);
    expect(await screen.findByText(/Fix: Done/)).toBeTruthy();
    expect(reads.filter((u) => u.startsWith("/api/pulls/files")).length).toBe(before + 1);
  });
});
