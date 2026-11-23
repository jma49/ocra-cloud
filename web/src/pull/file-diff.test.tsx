import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LineComment } from "../../../src/shared/index.js";
import type { DiffLayout } from "./diff-rows.js";
import { FileDiff } from "./file-diff.js";

afterEach(cleanup);

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

const show = (layout: DiffLayout, onComment = vi.fn<(c: LineComment) => void>(), path?: string) =>
  render(
    <FileDiff
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
