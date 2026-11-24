import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PullPage } from "../pages/PullPage.js";
import { ToastProvider } from "../toast.js";

// The conversation column and the file heads on a pull request's page: a
// thread leads the diff to its line, and the column's state is kept.

const HEAD = "a".repeat(40);
const PATCH = [
  "@@ -10,3 +10,4 @@ export function refund(",
  " const left = charge.captured;",
  "-if (amount > charge.amount) {",
  "+if (amount > left) {",
  "+  log(amount);",
  "   throw new RefundTooLarge(amount);",
].join("\n");

const file = (path: string, status = "modified") => ({
  path,
  oldPath: path,
  status,
  additions: 2,
  deletions: 1,
  patch: PATCH,
  viewed: false,
});

const files = {
  platform: "github",
  repo: "octo/api",
  number: 7,
  title: "Cap refunds",
  author: "ada",
  url: "https://github.com/octo/api/pull/7",
  base: "b".repeat(40),
  head: HEAD,
  files: [file("src/refund.ts"), file("src/old.py", "removed")],
  truncated: false,
  verdicts: ["comment"],
  mergeMethods: ["squash"],
};

const comment = (id: string, body: string) => ({
  id,
  author: "rev",
  body,
  createdAt: null,
  suggestions: [],
});
const thread = (id: string, over: object) => ({
  id,
  path: "src/refund.ts",
  line: 11,
  startLine: null,
  side: "new",
  resolved: false,
  outdated: false,
  canResolve: true,
  comments: [comment(`${id}c`, `Note ${id}`)],
  ...over,
});
const threads = {
  head: HEAD,
  truncated: false,
  threads: [
    thread("T1", { comments: [comment("a", "Return early."), comment("b", "Or this.")] }),
    thread("T2", { line: null, outdated: true }),
    thread("T3", { resolved: true, line: 12 }),
  ],
};

let scrolled: Element[] = [];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/pulls/threads")) return Response.json(threads);
      if (url.startsWith("/api/pulls/files")) return Response.json(files);
      if (url.startsWith("/api/pulls/stack")) return Response.json({ trunk: "", pulls: [] });
      if (url.startsWith("/api/pulls/queue")) {
        return Response.json({ enabled: false, entry: null, ahead: [], size: null, removed: null });
      }
      if (url.startsWith("/api/pulls/readiness")) {
        return Response.json({
          ready: null,
          items: [],
          codeOwners: [],
          staleApprovals: [],
          otherRules: [],
        });
      }
      if (url.startsWith("/api/pulls/reviewers"))
        return Response.json({ suggestions: [], owners: [] });
      if (url.startsWith("/api/pulls/labels")) {
        return Response.json({ applied: [], available: [], truncated: false });
      }
      if (url.startsWith("/api/pulls/draft")) return Response.json({ draft: false, state: "open" });
      if (url.startsWith("/api/pulls/description-draft")) {
        return Response.json({ head: HEAD, body: "", draft: null, review: null });
      }
      return Response.json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const show = () =>
  render(
    <ToastProvider>
      <PullPage platform="github" repo="octo/api" number="7" />
    </ToastProvider>,
  );

const column = () => screen.findByRole("complementary", { name: "Conversation" });

it("lists the threads by where they stand and leads the diff to a thread's line", async () => {
  show();
  const aside = await column();
  await waitFor(() => expect(aside.textContent).toContain("Return early."));
  const summaries = [...aside.querySelectorAll("summary")].map((s) => s.textContent);
  expect(summaries).toEqual(["Open1", "Outdated1", "Resolved1"]);
  fireEvent.click(within(aside).getByText(/Return early\./));
  await waitFor(() =>
    expect(scrolled.some((el) => el.textContent?.includes("if (amount > left) {"))).toBe(true),
  );
});

it("leads an outdated thread to its file", async () => {
  show();
  const aside = await column();
  await waitFor(() => expect(aside.textContent).toContain("Note T2"));
  fireEvent.click(within(aside).getByText(/Note T2/));
  expect(scrolled.at(-1)?.id).toBe("file-src/refund.ts");
});

it("counts a file's comments in its head and leads to the first", async () => {
  show();
  const count = await screen.findByRole("button", {
    name: "4 comments on src/refund.ts: go to the first",
  });
  fireEvent.click(count);
  await waitFor(() => expect(scrolled.at(-1)?.id).toBe("file-src/refund.ts"));
});

it("names each file's language and what happened to it", async () => {
  show();
  const removed = await screen.findByRole("region", { name: "src/old.py" });
  expect(removed.textContent).toContain("Deleted");
  expect(removed.textContent).toContain("Python");
  expect(screen.getByRole("region", { name: "src/refund.ts" }).textContent).toContain("TypeScript");
});

it("folds and opens the column with its button and the T key, and keeps it so", async () => {
  show();
  await column();
  fireEvent.click(screen.getByRole("button", { name: "Hide conversation" }));
  expect(await screen.findByRole("button", { name: "Show conversation (3)" })).toBeTruthy();
  expect(localStorage.getItem("ocra-pull-conversation")).toBe("closed");
  fireEvent.keyDown(document.body, { key: "t" });
  expect(await screen.findByRole("button", { name: "Hide conversation" })).toBeTruthy();
  expect(localStorage.getItem("ocra-pull-conversation")).toBe("open");
});

it("opens folded where this browser left it folded", async () => {
  localStorage.setItem("ocra-pull-conversation", "closed");
  show();
  expect(await screen.findByRole("button", { name: /^Show conversation/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide conversation" })).toBeNull();
});
