import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// What every stylesheet takes from base.css instead of setting itself.
const root = import.meta.dirname;
const sheets = [
  "signin.css",
  ...readdirSync(join(root, "styles"))
    .filter((f) => f.endsWith(".css") && f !== "base.css")
    .map((f) => join("styles", f)),
];
const css = (sheet: string) => readFileSync(join(root, sheet), "utf8");

describe("type scale", () => {
  it.each(sheets)("%s sets font sizes only through the scale's tokens", (sheet) => {
    const literal = css(sheet).match(/font(?:-size)?:[^;]*\d(?:px|rem|em)\b[^;]*;/g) ?? [];
    expect(literal.filter((d) => !d.includes("clamp("))).toEqual([]);
  });
});

describe("focus ring", () => {
  it.each([...sheets, join("styles", "base.css")])(
    "%s draws focus outlines in the focus colour",
    (sheet) => {
      const outlines = css(sheet).match(/outline:\s*\d[^;]*;/g) ?? [];
      expect(outlines.filter((o) => !o.includes("var(--focus)"))).toEqual([]);
    },
  );
});

describe("colour", () => {
  it.each(sheets)("%s takes its colours from base.css's tokens", (sheet) => {
    const literal =
      css(sheet).match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/gi) ?? [];
    expect(literal).toEqual([]);
  });
});

describe("icons", () => {
  const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
    /\.tsx?$/.test(f),
  );
  it("imports Lucide icons one by one, never the whole set", () => {
    const barrel = sources.filter((f) =>
      /^import (?!type )[^;]*from "lucide-react";/m.test(readFileSync(join(root, f), "utf8")),
    );
    expect(barrel).toEqual([]);
  });
});
