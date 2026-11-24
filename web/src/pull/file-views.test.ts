import { describe, expect, it } from "vitest";
import {
  ALL_FILES,
  choicesSet,
  type FileNarrowing,
  isNarrowed,
  narrowFiles,
  pathMatcher,
  readKept,
  sameNarrowing,
} from "./file-views.js";

const passing = (text: string, paths: string[]) => paths.filter(pathMatcher(text));

describe("pathMatcher", () => {
  const paths = [
    "src/pull.ts",
    "src/pull.test.ts",
    "web/src/pull/file-list.tsx",
    "web/src/styles/pull-files.css",
    "README.md",
  ];

  it("keeps every path for an empty field, and paths holding a word, ignoring case", () => {
    expect(passing("  ", paths)).toEqual(paths);
    expect(passing("FILE", paths)).toEqual([
      "web/src/pull/file-list.tsx",
      "web/src/styles/pull-files.css",
    ]);
  });

  it("matches a glob from any folder down, or from the top after a slash", () => {
    expect(passing("*.ts", paths)).toEqual(["src/pull.ts", "src/pull.test.ts"]);
    expect(passing("src/*.ts", paths)).toEqual(["src/pull.ts", "src/pull.test.ts"]);
    expect(passing("src/**/*.tsx", paths)).toEqual(["web/src/pull/file-list.tsx"]);
    expect(passing("/src/**", paths)).toEqual(["src/pull.ts", "src/pull.test.ts"]);
    expect(passing("readme.??", paths)).toEqual(["README.md"]);
  });

  it("keeps a path matching any word, and leaves out one matching a word after !", () => {
    expect(passing("*.css, *.md", paths)).toEqual(["web/src/styles/pull-files.css", "README.md"]);
    expect(passing("*.ts !*.test.ts", paths)).toEqual(["src/pull.ts"]);
    expect(passing("!web/ !", paths)).toEqual(["src/pull.ts", "src/pull.test.ts", "README.md"]);
  });

  it("reads the glob's other characters as themselves", () => {
    expect(passing("pull.(ts)", ["src/pull.(ts)", "src/pullxts"])).toEqual(["src/pull.(ts)"]);
    expect(passing("[a]*", ["[a]b.ts", "ab.ts"])).toEqual(["[a]b.ts"]);
  });
});

const file = (path: string, status: "added" | "modified" | "removed" | "renamed") => ({
  path,
  status,
});

describe("narrowFiles", () => {
  const files = [
    file("src/new.ts", "added"),
    file("src/old.ts", "removed"),
    file("src/app.ts", "modified"),
    file("src/moved.ts", "renamed"),
    file("package-lock.json", "modified"),
    file("vendor/lib/x.go", "added"),
  ];
  const viewed = new Set(["src/app.ts", "src/new.ts"]);
  const narrow = (n: Partial<FileNarrowing>, held?: Set<string>) =>
    narrowFiles(files, { ...ALL_FILES, ...n }, (f) => viewed.has(f.path), held).map((f) => f.path);

  it("keeps the files of the kinds chosen, in their order", () => {
    expect(narrow({})).toHaveLength(files.length);
    expect(narrow({ kinds: ["added", "renamed"] })).toEqual([
      "src/new.ts",
      "src/moved.ts",
      "vendor/lib/x.go",
    ]);
  });

  it("keeps viewed files or the rest, and leaves out lock files and vendored copies", () => {
    expect(narrow({ viewed: "viewed" })).toEqual(["src/new.ts", "src/app.ts"]);
    expect(narrow({ viewed: "unviewed", hideGenerated: true })).toEqual([
      "src/old.ts",
      "src/moved.ts",
    ]);
  });

  it("keeps a held file whatever its viewed tick, but not one its other choices leave out", () => {
    const held = new Set(["src/app.ts", "package-lock.json"]);
    expect(narrow({ viewed: "unviewed", hideGenerated: true }, held)).toEqual([
      "src/old.ts",
      "src/app.ts",
      "src/moved.ts",
    ]);
  });

  it("joins every choice with the path field", () => {
    expect(narrow({ path: "src/", kinds: ["added", "modified"], viewed: "viewed" })).toEqual([
      "src/new.ts",
      "src/app.ts",
    ]);
  });
});

it("tells a narrowing apart by what it keeps, not how it was spelled", () => {
  expect(isNarrowed(ALL_FILES)).toBe(false);
  expect(isNarrowed({ ...ALL_FILES, path: "   " })).toBe(false);
  expect(
    sameNarrowing(
      { ...ALL_FILES, kinds: ["removed", "added"] },
      {
        ...ALL_FILES,
        kinds: ["added", "removed"],
      },
    ),
  ).toBe(true);
  expect(sameNarrowing({ ...ALL_FILES, hideGenerated: true }, ALL_FILES)).toBe(false);
  expect(
    choicesSet({ path: "x", kinds: ["added", "removed"], viewed: "viewed", hideGenerated: false }),
  ).toBe(2);
});

describe("readKept", () => {
  it("reads the views kept and the one picked", () => {
    const kept = {
      views: [
        {
          name: "New code",
          narrowing: { path: "*.ts", kinds: ["added"], viewed: "any", hideGenerated: true },
        },
      ],
      picked: "New code",
    };
    expect(readKept(JSON.stringify(kept))).toEqual(kept);
  });

  it("leaves out what does not read, and fills what an older view lacks", () => {
    const raw = JSON.stringify({
      views: [
        { name: "  Docs  ", narrowing: { path: "*.md" } },
        { name: "Docs", narrowing: {} },
        { name: "", narrowing: {} },
        { name: "No narrowing" },
        {
          name: "Odd",
          narrowing: { kinds: ["added", "copied"], viewed: "sometimes", hideGenerated: "yes" },
        },
        "text",
        null,
      ],
      picked: "Gone",
    });
    expect(readKept(raw)).toEqual({
      views: [
        { name: "Docs", narrowing: { ...ALL_FILES, path: "*.md" } },
        { name: "Odd", narrowing: { ...ALL_FILES, kinds: ["added"] } },
      ],
      picked: null,
    });
    expect(readKept("{not json")).toEqual({ views: [], picked: null });
    expect(readKept(null)).toEqual({ views: [], picked: null });
  });
});
