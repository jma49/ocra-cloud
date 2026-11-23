import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = import.meta.dirname;
const views = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && !f.startsWith("components"))
  .map((f) => join(root, f));

describe("markup", () => {
  it("names every table column, if only for screen readers", () => {
    const unnamed = views.filter((f) => /<th\s*\/>|<th>\s*<\/th>/.test(readFileSync(f, "utf8")));
    expect(unnamed.map((f) => relative(root, f))).toEqual([]);
  });
});
