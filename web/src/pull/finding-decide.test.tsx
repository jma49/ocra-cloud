import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PullPage } from "../pages/PullPage.js";
import { ToastProvider } from "../toast.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const PATCH = ["@@ -10,2 +10,3 @@", " const left = captured;", "+log(amount);", " refund(amount);"];
const files = {
  platform: "github",
  repo: "octo/api",
  number: 7,
  title: "Cap refunds",
  author: "ada",
  url: "https://github.com/octo/api/pull/7",
  base: "b".repeat(40),
  head: HEAD,
  files: [
    {
      path: "src/refund.ts",
      oldPath: "src/refund.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: PATCH.join("\n"),
      viewed: false,
    },
  ],
  truncated: false,
  verdicts: ["comment"],
  mergeMethods: [],
};
const finding = {
  id: "f1",
  severity: "warning",
  title: "Logs the amount",
  body: "The amount is personal data.",
  file: "src/refund.ts",
  lineStart: 11,
  lineEnd: 11,
  hasFix: false,
};
const READS: Record<string, unknown> = {
  "/api/pulls/files": files,
  "/api/pulls/findings/earlier": { findings: [] },
  "/api/pulls/findings": { review: { id: "r1", head: HEAD }, findings: [finding] },
  "/api/pulls/readiness": {
    ready: null,
    items: [],
    codeOwners: [],
    staleApprovals: [],
    otherRules: [],
  },
  "/api/pulls/stack": { trunk: "", pulls: [] },
  "/api/pulls/reviewers": { suggestions: [], owners: [] },
  "/api/pulls/threads": { head: HEAD, truncated: false, threads: [] },
  "/api/pulls/labels": { applied: [], available: [], truncated: false },
  "/api/pulls/queue": { enabled: false, entry: null, ahead: [], size: null, removed: null },
  "/api/pulls/description-draft": { head: HEAD, body: "", draft: null, review: null },
};

/** Opens the page; `decide` answers each POST to /findings/decide. */
function open(decide: () => Response) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/findings/decide") {
        sent.push(JSON.parse(String(init?.body)));
        return decide();
      }
      const read = Object.entries(READS).find(([path]) => url.startsWith(path));
      return Response.json(read ? read[1] : {});
    }),
  );
  render(
    <ToastProvider>
      <PullPage platform="github" repo="octo/api" number="7" />
    </ToastProvider>,
  );
  return sent;
}

const note = () => screen.queryByRole("region", { name: "ocra's finding: Logs the amount" });
const done = () => Response.json({ changed: 1, remembered: 0 });

it("marks a finding fixed from the diff, takes it off, and puts it back on Undo", async () => {
  const sent = open(done);
  fireEvent.click(await screen.findByRole("button", { name: "Mark fixed" }));
  expect(note()).toBeNull();
  await act(async () => void fireEvent.click(await screen.findByRole("button", { name: "Undo" })));
  await waitFor(() => expect(note()).not.toBeNull());
  expect(sent).toEqual([
    { ids: ["f1"], status: "fixed" },
    { ids: ["f1"], status: "open" },
  ]);
});

it("asks why in place before it dismisses, and can remember it for the repository", async () => {
  const sent = open(() => Response.json({ changed: 1, remembered: 1 }));
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Why dismiss it" }), {
    target: { value: "not_important" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Remember for this repository" }));
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
  expect(note()).toBeNull();
  expect(sent).toEqual([
    { ids: ["f1"], status: "dismissed", reason: "not_important", remember: true },
  ]);
  expect(await screen.findByText(/its repository's next review will not report it/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("leaves the finding on the diff when the decision is refused", async () => {
  open(() => Response.json({ error: "internal" }, { status: 500 }));
  fireEvent.click(await screen.findByRole("button", { name: "Mark fixed" }));
  await waitFor(() => expect(note()).not.toBeNull());
  expect(await screen.findByText(/Could not decide on the finding/)).toBeTruthy();
});

it("cancels a dismissal with Escape", async () => {
  open(done);
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Why dismiss it" }), { key: "Escape" });
  expect(screen.queryByRole("combobox", { name: "Why dismiss it" })).toBeNull();
  expect(screen.getByRole("button", { name: "Mark fixed" })).toBeTruthy();
});
