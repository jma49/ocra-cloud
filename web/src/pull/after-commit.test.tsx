import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PullPage } from "../pages/PullPage.js";
import { ToastProvider } from "../toast.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OLD = "a".repeat(40);
const NEW = "c".repeat(40);
const file = (path: string, line: string) => ({
  path,
  oldPath: path,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: `@@ -1,1 +1,2 @@\n const a = 1;\n+${line}`,
  viewed: false,
});
const pull = (head: string, files: unknown[]) => ({
  platform: "github",
  repo: "octo/api",
  number: 7,
  title: "Cap refunds",
  author: "ada",
  url: "https://github.com/octo/api/pull/7",
  base: "b".repeat(40),
  head,
  files,
  truncated: false,
  verdicts: ["comment"],
  mergeMethods: ["squash"],
});
const fix = {
  finding: "f1",
  title: "Clamp the amount",
  severity: "warning",
  file: "src/refund.ts",
  startLine: 2,
  endLine: 2,
  before: ["log(amount);"],
  after: ["log(Math.max(amount, 0));"],
};

it("reads the pull request again until a committed fix moves its head", async () => {
  // The platform answers the old head for a moment after the commit.
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ outcome: "done" });
      if (url.startsWith("/api/pulls/files")) {
        reads += 1;
        return Response.json(
          reads <= 2
            ? pull(OLD, [file("src/refund.ts", "log(amount);")])
            : pull(NEW, [file("src/refund.ts", "log(Math.max(amount, 0));")]),
        );
      }
      if (url.startsWith("/api/pulls/fixes")) {
        return Response.json(
          url.includes(OLD)
            ? { review: { id: "r1", head: OLD }, fixes: [fix] }
            : { review: null, fixes: [] },
        );
      }
      if (url.startsWith("/api/pulls/stack")) return Response.json({ trunk: "", pulls: [] });
      if (url.startsWith("/api/pulls/description-draft")) {
        return Response.json({ head: OLD, body: "", draft: null, review: null });
      }
      return Response.json({}, { status: 404 });
    }),
  );
  render(
    <ToastProvider>
      <PullPage platform="github" repo="octo/api" number="7" />
    </ToastProvider>,
  );
  const commit = await screen.findByRole("button", { name: "Commit fix" }, { timeout: 3000 });
  await act(async () => void fireEvent.click(commit));
  await waitFor(
    () => expect(screen.queryByRole("region", { name: "ocra's fix: Clamp the amount" })).toBeNull(),
    { timeout: 5000 },
  );
  expect(document.querySelector(".diff-file")?.textContent).toContain("+log(Math.max(amount, 0));");
});
