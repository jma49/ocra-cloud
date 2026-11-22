import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sizes come from the type scale in base.css, so the console keeps one set of them.
const root = import.meta.dirname;
const sheets = [
  "signin.css",
  ...readdirSync(join(root, "styles"))
    .filter((f) => f.endsWith(".css") && f !== "base.css")
    .map((f) => join("styles", f)),
];

describe("type scale", () => {
  it.each(sheets)("%s sets font sizes only through the scale's tokens", (sheet) => {
    const css = readFileSync(join(root, sheet), "utf8");
    const literal = css.match(/font(?:-size)?:[^;]*\d(?:px|rem|em)\b[^;]*;/g) ?? [];
    expect(literal.filter((d) => !d.includes("clamp("))).toEqual([]);
  });
});
