import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PullFilesView } from "../../../src/shared/index.js";
import { PullMeta } from "./meta.js";

afterEach(cleanup);

const file = (path: string, additions: number, deletions: number) => ({
  path,
  oldPath: path,
  status: "modified" as const,
  additions,
  deletions,
  patch: null,
  viewed: null,
});

const view: PullFilesView = {
  platform: "github",
  repo: "octo/api",
  number: 7,
  title: "Cap refunds",
  author: "ada",
  url: null,
  state: "open",
  base: "b".repeat(40),
  head: "a1b2c3d".padEnd(40, "0"),
  updatedAt: null,
  branches: { head: "fix/refund-cap", base: "main" },
  authorAvatar: "https://avatars.githubusercontent.com/u/1",
  files: [file("a.ts", 3, 1), file("b.ts", 4, 0)],
  truncated: false,
  verdicts: [],
  mergeMethods: [],
};

it("says who opened it, what merges into what, and how much it changes", () => {
  const { container } = render(<PullMeta data={view} />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe(view.authorAvatar);
  expect(screen.getByText("ada")).toBeTruthy();
  expect([...container.querySelectorAll(".branch")].map((b) => b.textContent)).toEqual([
    "fix/refund-cap",
    "main",
  ]);
  expect(container.querySelector(".pull-size")?.textContent).toBe("2 files +7 −1");
  expect(screen.queryByText(/Updated/)).toBeNull();
});

it("falls back to the author's initial and the head's commit where the platform named neither", () => {
  const { container } = render(<PullMeta data={{ ...view, branches: null, authorAvatar: null }} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".person-mark")?.textContent).toBe("A");
  expect(container.textContent).toContain("head a1b2c3d");
});
