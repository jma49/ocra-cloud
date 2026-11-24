import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LineComment, PullFilesView } from "../../../src/shared/index.js";
import { pullCommands } from "./commands.js";
import { DiffBar } from "./diff-bar.js";
import { useDiffLayout, useDiffWhitespace, useDiffWrap } from "./diff-layout.js";
import { FileDiff } from "./file-diff.js";

// A diff with whitespace-only changes left out: the toggle is kept between
// visits, and what was anchored to a line the diff no longer draws still shows.

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const file = (patch: string) => ({
  path: "src/refund.ts",
  oldPath: "src/refund.ts",
  status: "modified" as const,
  additions: 2,
  deletions: 2,
  patch,
  viewed: false,
});

const show = (patch: string, pending: LineComment[]) =>
  render(
    <FileDiff
      file={file(patch)}
      layout="unified"
      viewed={false}
      onViewed={() => undefined}
      pending={pending}
      onComment={() => undefined}
      onDrop={() => undefined}
      findings={[]}
      review={null}
      fixes={[]}
      onDecided={() => undefined}
      onFixDone={() => undefined}
      hideWhitespace
    />,
  );

it("says a file only changed whitespace", () => {
  show("", []);
  expect(screen.getByText("Only whitespace changed in this file.")).toBeTruthy();
});

it("keeps a comment on a removed line the filter folded into an unchanged one, at the diff's top", () => {
  // The server turned `-  a` / `+a` into the unchanged line 1; the comment was on old line 1.
  const onOld: LineComment = {
    path: "src/refund.ts",
    line: 1,
    side: "old",
    body: "why re-indent?",
  };
  show("@@ -1,2 +1,2 @@\n a\n-b\n+c", [onOld]);
  expect(screen.getByText(/hidden by the whitespace filter/)).toBeTruthy();
  const rows = [...document.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
  expect(rows.findIndex((r) => r.includes("why re-indent?"))).toBeLessThan(
    rows.findIndex((r) => r.endsWith("a")),
  );
});

function Bar() {
  const layout = useDiffLayout();
  return (
    <DiffBar layout={layout} wrap={useDiffWrap(layout.narrow)} whitespace={useDiffWhitespace()} />
  );
}

it("remembers the choice in this browser", () => {
  const { unmount } = render(<Bar />);
  fireEvent.click(screen.getByRole("button", { name: "Hide whitespace" }));
  expect(localStorage.getItem("ocra-diff-whitespace")).toBe("hide");
  unmount();
  render(<Bar />);
  expect(screen.getByRole("button", { name: "Hide whitespace" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("toggles on w from the page's keys", () => {
  const toggle = vi.fn();
  const data = { state: "open", url: null, verdicts: [] } as unknown as PullFilesView;
  const commands = pullCommands({
    data,
    code: { current: null },
    review: () => undefined,
    toggleViewed: () => undefined,
    whitespace: { hidden: false, toggle },
    beside: null,
  });
  const w = commands.find((c) => c.key === "w");
  expect(w?.label).toBe("Hide whitespace changes");
  w?.run();
  expect(toggle).toHaveBeenCalled();
});
