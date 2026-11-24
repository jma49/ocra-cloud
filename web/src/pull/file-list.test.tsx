import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PullFileView } from "../../../src/shared/index.js";
import { ToastProvider } from "../toast.js";
import { FileList } from "./file-list.js";
import { useFileViews } from "./file-views.js";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const KEY = "ocra-pull-file-views";

const file = (path: string, status: PullFileView["status"] = "modified"): PullFileView => ({
  path,
  oldPath: path,
  status,
  additions: status === "removed" ? 0 : 3,
  deletions: status === "added" ? 0 : 2,
  patch: null,
  viewed: null,
});

/** The tree as the page draws it: the files its view keeps, beside all of them. */
function Tree(props: { files: PullFileView[]; isViewed: (f: PullFileView) => boolean }) {
  const views = useFileViews("github:acme/pay#7");
  const shown = views.narrow(props.files, props.isViewed);
  return <FileList files={props.files} shown={shown} isViewed={props.isViewed} views={views} />;
}

const page = (files: PullFileView[], isViewed: (f: PullFileView) => boolean) => (
  <ToastProvider>
    <Tree files={files} isViewed={isViewed} />
  </ToastProvider>
);

const tree = (files: PullFileView[], isViewed: (f: PullFileView) => boolean = () => false) =>
  render(page(files, isViewed));

const links = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));
const kept = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

const MANY = [
  file("src/new.ts", "added"),
  file("src/old.ts", "removed"),
  file("src/moved.ts", "renamed"),
  file("package-lock.json"),
  ...Array.from({ length: 5 }, (_, i) => file(`src/part${i}/index.ts`)),
];

it("lists each file under its folder, linked to its diff, with what happened to it", () => {
  const files = [file(".changeset/refund.md", "added"), file("src/old.ts", "removed")];
  tree(files, (f) => f.path === "src/old.ts");
  const added = screen.getByTitle(".changeset/refund.md (added)");
  expect(added.querySelector(".file-name")?.textContent).toBe("refund.md");
  expect(added.getAttribute("href")).toBe("#file-.changeset/refund.md");
  expect(added.querySelector(".diff-count")?.textContent).toBe("+3");
  expect(added.querySelector(".file-status")?.textContent).toBe("A");
  expect(added.style.getPropertyValue("--depth")).toBe("1");
  expect(added.querySelector("img.file-type")).toBeTruthy();
  expect(screen.getByTitle(".changeset").textContent).toBe(".changeset");
  expect(screen.getByTitle("src/old.ts (removed, viewed)").className).toContain("is-viewed");
  expect(screen.getByText("1 of 2 files viewed")).toBeTruthy();
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /^File view/ })).toBeNull();
});

it("narrows a long list by path or glob, and says when nothing matches", () => {
  const files = Array.from({ length: 9 }, (_, i) => file(`src/part${i}/index.ts`));
  tree(files);
  const filter = screen.getByRole("searchbox", { name: "Filter files by path" });
  fireEvent.change(filter, { target: { value: "PART3" } });
  expect(links()).toEqual(["#file-src/part3/index.ts"]);
  expect(screen.getByText("1 file of 9")).toBeTruthy();
  expect(screen.getByRole("button", { name: "File view: Custom" })).toBeTruthy();
  fireEvent.change(filter, { target: { value: "part1/* part2/*" } });
  expect(links()).toEqual(["#file-src/part1/index.ts", "#file-src/part2/index.ts"]);
  fireEvent.change(filter, { target: { value: "*.ts !part1/ !part2/" } });
  expect(links()).toHaveLength(7);
  fireEvent.change(filter, { target: { value: "nowhere" } });
  expect(links()).toEqual([]);
  expect(screen.getByText("No file matches.")).toBeTruthy();
});

it("narrows by what happened to a file and leaves out lock files from the filter menu", async () => {
  tree(MANY);
  fireEvent.click(screen.getByRole("button", { name: "Filter files" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Added" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Renamed" }));
  expect(links()).toEqual(["#file-src/new.ts", "#file-src/moved.ts"]);
  expect(screen.getByRole("button", { name: "Filter files: 1 set" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Show all files" }));
  await waitFor(() => expect(links()).toHaveLength(MANY.length));
  fireEvent.click(screen.getByRole("button", { name: "Filter files" }));
  fireEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Hide lock and generated files" }),
  );
  expect(links()).not.toContain("#file-package-lock.json");
  expect(links()).toHaveLength(MANY.length - 1);
});

it("keeps a file ticked under Not viewed until the view changes", async () => {
  const ticked = new Set<string>();
  const isViewed = (f: PullFileView) => ticked.has(f.path);
  const { rerender } = tree(MANY, isViewed);
  fireEvent.click(screen.getByRole("button", { name: "Filter files" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Not viewed" }));
  expect(links()).toHaveLength(MANY.length);
  ticked.add("src/new.ts");
  rerender(page(MANY, isViewed));
  expect(links()).toContain("#file-src/new.ts");
  expect(screen.getByText("1 of 9 files viewed")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Viewed" }));
  expect(links()).toEqual(["#file-src/new.ts"]);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Not viewed" }));
  expect(links()).not.toContain("#file-src/new.ts");
  expect(links()).toHaveLength(MANY.length - 1);
});

it("saves the narrowing as a view kept in this browser, picked again on the next visit", async () => {
  const first = tree(MANY);
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter files by path" }), {
    target: { value: "src/" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Filter files" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Added" }));
  fireEvent.click(screen.getByRole("button", { name: "File view: Custom" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save as new view…" }));
  const name = await screen.findByRole("textbox", { name: "Name of the view" });
  await waitFor(() => expect(document.activeElement).toBe(name));
  fireEvent.change(name, { target: { value: "New code" } });
  fireEvent.submit(name);
  const picker = await screen.findByRole("button", { name: "File view: New code" });
  await waitFor(() => expect(document.activeElement).toBe(picker));
  expect(screen.queryByRole("textbox", { name: "Name of the view" })).toBeNull();
  expect(links()).toEqual(["#file-src/new.ts"]);
  first.unmount();

  tree(MANY);
  expect(screen.getByRole("searchbox", { name: "Filter files by path" })).toHaveProperty(
    "value",
    "src/",
  );
  expect(links()).toEqual(["#file-src/new.ts"]);
  fireEvent.click(screen.getByRole("button", { name: "File view: New code" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "All files" }));
  await waitFor(() => expect(links()).toHaveLength(MANY.length));
  expect(kept().picked).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "File view: All files" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "New code" }));
  await waitFor(() => expect(links()).toEqual(["#file-src/new.ts"]));
});

it("closes the name field on Escape without saving", async () => {
  tree(MANY);
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter files by path" }), {
    target: { value: "part" },
  });
  fireEvent.click(screen.getByRole("button", { name: "File view: Custom" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save as new view…" }));
  const name = await screen.findByRole("textbox", { name: "Name of the view" });
  fireEvent.change(name, { target: { value: "Parts" } });
  fireEvent.keyDown(name, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Name of the view" })).toBeNull();
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("marks a picked view edited, updates it, and deletes it with an undo", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      views: [{ name: "Gone", narrowing: { path: "", kinds: ["removed"], viewed: "any" } }],
      picked: "Gone",
    }),
  );
  tree(MANY);
  expect(links()).toEqual(["#file-src/old.ts"]);
  fireEvent.click(screen.getByRole("button", { name: "Filter files: 1 set" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Added" }));
  fireEvent.click(screen.getByRole("button", { name: "File view: Gone, edited" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Update “Gone”" }));
  await screen.findByRole("button", { name: "File view: Gone" });
  expect(kept().views[0].narrowing.kinds).toEqual(["added", "removed"]);

  fireEvent.click(screen.getByRole("button", { name: "File view: Gone" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete “Gone”" }));
  await screen.findByRole("button", { name: "File view: Custom" });
  expect(kept()).toEqual({ views: [], picked: null });
  expect(links()).toEqual(["#file-src/new.ts", "#file-src/old.ts"]);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByRole("button", { name: "File view: Gone" });
  await act(async () => {});
  expect(kept().picked).toBe("Gone");
});
