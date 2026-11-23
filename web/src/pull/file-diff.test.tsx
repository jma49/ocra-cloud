import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LineComment } from "../../../src/shared/index.js";
import type { DiffLayout } from "./diff-rows.js";
import { FileDiff } from "./file-diff.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PATCH = [
  "@@ -52,4 +52,4 @@",
  " const left = charge.captured - charge.refunded;",
  "-if (amount > charge.captured) {",
  "+if (amount > left) {",
  "   throw new RefundTooLarge(amount);",
  "+log(amount);",
].join("\n");
const file = (path = "src/refunds/partial.ts") => ({
  path,
  oldPath: path,
  status: "modified" as const,
  additions: 2,
  deletions: 1,
  patch: PATCH,
  viewed: false,
});

const HEAD = "a".repeat(40);
const show = (
  layout: DiffLayout,
  onComment = vi.fn<(c: LineComment) => void>(),
  path?: string,
  context = false,
) =>
  render(
    <FileDiff
      context={
        context
          ? { pull: { platform: "github", repo: "acme/pay", number: 4 }, head: HEAD }
          : undefined
      }
      file={file(path)}
      layout={layout}
      viewed={false}
      onViewed={() => undefined}
      pending={[]}
      onComment={onComment}
      onDrop={() => undefined}
      findings={[]}
      review={null}
      fixes={[]}
      onFixDone={() => undefined}
    />,
  );

const rowTexts = () => [...document.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");

it("sets the removed line beside the one that replaced it, split", () => {
  show("split");
  const rows = rowTexts();
  expect(rows.some((r) => r.includes("charge.captured) {") && r.includes("amount > left"))).toBe(
    true,
  );
  // An added line with no removed line beside it leaves the old side blank.
  expect(document.querySelectorAll(".diff-empty")).toHaveLength(2);
});

it("marks the words that changed, on both sides", () => {
  show("unified");
  const marked = [...document.querySelectorAll(".diff-word")].map((m) => m.textContent);
  expect(marked).toEqual(["charge.captured", "left"]);
});

it("comments on a removed line from its old number and an added one from its new, split", () => {
  const onComment = vi.fn<(c: LineComment) => void>();
  show("split", onComment);
  fireEvent.click(screen.getByRole("button", { name: "Comment on removed line 53" }));
  fireEvent.change(screen.getByLabelText("Your comment on removed line 53"), {
    target: { value: "Why the change?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
  expect(onComment).toHaveBeenCalledWith({
    path: "src/refunds/partial.ts",
    line: 53,
    side: "old",
    body: "Why the change?",
  });
  expect(screen.getByRole("button", { name: "Comment on line 55" })).toBeTruthy();
  // A context line takes its comment on the new side only.
  expect(screen.queryByRole("button", { name: "Comment on removed line 52" })).toBeNull();
});

it("folds a lock file and names it, one click from its diff", () => {
  show("unified", undefined, "package-lock.json");
  const head = screen.getByRole("button", { expanded: false });
  expect(head.textContent).toContain("Lock file");
  expect(document.querySelector("table")).toBeNull();
  fireEvent.click(head);
  expect(document.querySelector("table")).not.toBeNull();
});

it("shows the lines left out above a hunk, read at the head, numbered on both sides", async () => {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const q = new URL(url, "http://x").searchParams;
      const from = Number(q.get("from"));
      const to = Number(q.get("to"));
      return Response.json({
        path: q.get("path"),
        head: q.get("head"),
        from,
        lines: Array.from({ length: to - from + 1 }, (_, i) => `kept ${from + i}`),
        total: 80,
      });
    }),
  );
  show("unified", undefined, undefined, true);
  expect(screen.getByText("51 hidden")).toBeTruthy();
  // Nothing comes before the first hunk, so its gap only opens upward; the end only downward.
  expect(screen.getAllByRole("button", { name: /below the change above/ })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /above the change below/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Show 20 lines above the change below" }));
  await waitFor(() => expect(screen.getByText("kept 51")).toBeTruthy());
  expect(asked).toEqual([
    `/api/pulls/lines?platform=github&repo=acme%2Fpay&number=4&head=${HEAD}&path=src%2Frefunds%2Fpartial.ts&from=32&to=51`,
  ]);
  expect(screen.getByText("31 hidden")).toBeTruthy();
  const row = screen.getByText("kept 51").closest("tr");
  expect([...(row?.querySelectorAll(".diff-no") ?? [])].map((c) => c.textContent)).toEqual([
    "51",
    "51",
  ]);
});

it("leaves an added file without gaps to open", () => {
  render(
    <FileDiff
      context={{ pull: { platform: "github", repo: "acme/pay", number: 4 }, head: HEAD }}
      file={{ ...file(), status: "added" }}
      layout="unified"
      viewed={false}
      onViewed={() => undefined}
      pending={[]}
      onComment={() => undefined}
      onDrop={() => undefined}
      findings={[]}
      review={null}
      fixes={[]}
      onFixDone={() => undefined}
    />,
  );
  expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
});

it("marks what a find found, opens a folded file to its match and scrolls to it", () => {
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  render(
    <FileDiff
      file={file("package-lock.json")}
      layout="unified"
      viewed={false}
      onViewed={() => undefined}
      pending={[]}
      onComment={() => undefined}
      onDrop={() => undefined}
      findings={[]}
      review={null}
      fixes={[]}
      onFixDone={() => undefined}
      found={
        new Map([
          [3, [{ from: 13, to: 17 }]],
          [5, [{ from: 0, to: 3 }]],
        ])
      }
      focus={{ path: "package-lock.json", line: 3, from: 13, to: 17, step: 1 }}
    />,
  );
  expect(document.querySelector("table")).not.toBeNull();
  expect([...document.querySelectorAll(".diff-found")].map((m) => m.textContent)).toEqual([
    "left",
    "log",
  ]);
  expect(document.querySelector(".diff-found.is-current")?.textContent).toBe("left");
  expect(scrolled).toHaveBeenCalled();
  expect((scrolled.mock.contexts[0] as Element).getAttribute("data-at")).toBe("3");
});
