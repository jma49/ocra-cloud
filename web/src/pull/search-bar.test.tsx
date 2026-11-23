import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PullFilesView } from "../../../src/shared/index.js";
import { SearchBar } from "./search-bar.js";
import { useDiffSearch } from "./use-diff-search.js";

afterEach(cleanup);

type File = PullFilesView["files"][number];
const file = (path: string, patch: string): File => ({
  path,
  oldPath: path,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch,
  viewed: false,
});
const FILES = [
  file("a.ts", "@@ -1,1 +1,2 @@\n refund(a);\n+refund(b);"),
  file("package-lock.json", "@@ -1,1 +1,1 @@\n-x\n+refund"),
];

let shown: ReturnType<typeof useDiffSearch> | undefined;
function Page() {
  const search = useDiffSearch(FILES);
  shown = search;
  return <SearchBar search={search} />;
}

const find = (target: EventTarget = window) => {
  const e = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
};

it("opens on Ctrl+F, counts matches in every file and steps through them with Enter", () => {
  render(<Page />);
  expect(screen.queryByRole("search")).toBeNull();
  expect(find().defaultPrevented).toBe(true);
  const field = screen.getByRole("textbox", { name: "Find in the changes" });
  fireEvent.change(field, { target: { value: "REFUND" } });
  expect(screen.getByText("1 of 3")).toBeTruthy();
  expect(shown?.focus).toMatchObject({ path: "a.ts", line: 1 });
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByText("3 of 3")).toBeTruthy();
  expect(shown?.focus).toMatchObject({ path: "package-lock.json", line: 2 });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByText("1 of 3")).toBeTruthy();
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(screen.getByText("3 of 3")).toBeTruthy();
});

it("gives the browser's find back from its field, and closes on Escape", () => {
  render(<Page />);
  find();
  const field = screen.getByRole("textbox", { name: "Find in the changes" });
  field.focus();
  expect(find(field).defaultPrevented).toBe(false);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("search")).toBeNull();
  expect(shown?.focus).toBeNull();
});

it("says when nothing matches", () => {
  render(<Page />);
  find();
  fireEvent.change(screen.getByRole("textbox", { name: "Find in the changes" }), {
    target: { value: "nowhere" },
  });
  expect(screen.getByText("No matches")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next match" }).hasAttribute("disabled")).toBe(true);
});
