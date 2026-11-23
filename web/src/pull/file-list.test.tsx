import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FileList } from "./file-list.js";

afterEach(cleanup);

const file = (path: string, status: "added" | "removed" | "modified" = "modified") => ({
  path,
  oldPath: path,
  status,
  additions: status === "removed" ? 0 : 3,
  deletions: status === "added" ? 0 : 2,
  patch: null,
  viewed: null,
});

it("lists each file under its folder, linked to its diff, with what happened to it", () => {
  const files = [file(".changeset/refund.md", "added"), file("src/old.ts", "removed")];
  render(<FileList files={files} isViewed={(f) => f.path === "src/old.ts"} />);
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
});

it("narrows a long list by path, and says when nothing matches", () => {
  const files = Array.from({ length: 9 }, (_, i) => file(`src/part${i}/index.ts`));
  render(<FileList files={files} isViewed={() => false} />);
  const filter = screen.getByRole("searchbox", { name: "Filter files by path" });
  fireEvent.change(filter, { target: { value: "PART3" } });
  expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
    "#file-src/part3/index.ts",
  ]);
  expect(screen.getByText("1 file of 9")).toBeTruthy();
  fireEvent.change(filter, { target: { value: "nowhere" } });
  expect(screen.queryAllByRole("link")).toEqual([]);
  expect(screen.getByText("No file matches.")).toBeTruthy();
});
