import { expect, it } from "vitest";
import { parsePatch } from "./diff.js";
import { highlightDiff, languageOf } from "./highlight.js";

const patch = [
  "@@ -1,3 +1,3 @@",
  " // total of a cart",
  "-const total = sum(items);",
  '+const total = sum(items, "eur");',
  " export { total };",
].join("\n");

const kinds = (runs: { text: string; kind: string | null }[] | undefined) =>
  Object.fromEntries((runs ?? []).filter((r) => r.kind).map((r) => [r.text.trim(), r.kind]));

it("reads a path's language from its name, and leaves an unknown kind plain", () => {
  expect(languageOf("web/src/App.TSX")).toBe("tsx");
  expect(languageOf("Dockerfile")).toBe("docker");
  expect(languageOf("LICENSE")).toBeNull();
  expect(languageOf("notes.xyz")).toBeNull();
});

it("colours every line of a hunk, a removed one in the code it stood in", async () => {
  const lines = parsePatch(patch);
  const runs = await highlightDiff("src/cart.ts", lines);
  expect(runs.has(0)).toBe(false);
  expect(kinds(runs.get(1))).toMatchObject({ "// total of a cart": "comment" });
  expect(kinds(runs.get(2))).toMatchObject({ const: "keyword", sum: "function" });
  expect(kinds(runs.get(3))).toMatchObject({ const: "keyword", '"eur"': "string-expression" });
  expect(kinds(runs.get(4))).toMatchObject({ export: "keyword" });
  // Each line's runs spell the line: nothing is lost or added.
  lines.forEach((line, i) => {
    const drawn = runs.get(i);
    if (drawn) expect(drawn.map((r) => r.text).join("")).toBe(line.text);
  });
});

it("leaves a file plain when its kind is unknown or a line is too long to be written by hand", async () => {
  expect((await highlightDiff("notes.xyz", parsePatch(patch))).size).toBe(0);
  const long = parsePatch(`@@ -1 +1 @@\n+const a = "${"x".repeat(1200)}";`);
  expect((await highlightDiff("min.js", long)).size).toBe(0);
});
