import { expect, it } from "vitest";
import { fileTree, treeOrder } from "./file-tree.js";

const show = (paths: string[]) =>
  fileTree(paths.map((path) => ({ path }))).map(
    (r) => `${"  ".repeat(r.depth)}${r.kind === "dir" ? `${r.name}/` : r.name}`,
  );

it("puts each file under its folder and joins a chain of single folders into one row", () => {
  expect(
    show([
      ".changeset/done.md",
      "docs/adr/0063.md",
      "docs/adr/README.md",
      "packages/core/src/runtime/fakes.ts",
      "packages/runtime-opencode/src/done.ts",
      "packages/runtime-opencode/src/done.test.ts",
      "README.md",
    ]),
  ).toEqual([
    ".changeset/",
    "  done.md",
    "docs/adr/",
    "  0063.md",
    "  README.md",
    "packages/",
    "  core/src/runtime/",
    "    fakes.ts",
    "  runtime-opencode/src/",
    "    done.ts",
    "    done.test.ts",
    "README.md",
  ]);
});

it("keeps a folder that holds both files and folders as its own row, and any name as a name", () => {
  expect(show(["src/a.ts", "src/pull/b.ts", "__proto__/c.ts"])).toEqual([
    "src/",
    "  pull/",
    "    b.ts",
    "  a.ts",
    "__proto__/",
    "  c.ts",
  ]);
  expect(fileTree([])).toEqual([]);
});

it("lists the files in the tree's order, folders before the files beside them", () => {
  const paths = [".gitignore", "AGENTS.md", "docs/handoff.md"].map((path) => ({ path }));
  expect(treeOrder(paths).map((f) => f.path)).toEqual([
    "docs/handoff.md",
    ".gitignore",
    "AGENTS.md",
  ]);
});
