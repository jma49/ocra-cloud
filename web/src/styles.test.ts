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

describe("control heights", () => {
  // The sign-in page stands alone, with larger controls of its own.
  const console = sheets.filter((sheet) => sheet !== "signin.css");
  it.each(console)("%s leaves a control's height to --ctl-h and --ctl-h-lg", (sheet) => {
    const rules =
      css(sheet)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const fixed = rules.filter(
      (rule) =>
        /(?:\.input|\.icon-btn|button|select)[^,{]*\{/.test(rule) &&
        /(?:^|[\s;{])(?:min-)?height:\s*\d+px/.test(rule),
    );
    expect(fixed.map((rule) => rule.trim().split("{")[0]?.trim())).toEqual([]);
  });
});

describe("spacing scale", () => {
  const scale = new Set([0, 0.5, 1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64]);
  // A margin under 8px is an optical nudge (a dot centred on a line of text), not a step of the layout.
  const offScale = (property: string, px: number) =>
    !scale.has(px) && !(property.startsWith("margin") && px < 8);
  it.each(sheets.filter((sheet) => sheet !== "signin.css"))(
    "%s sets paddings, gaps and margins on the scale",
    (sheet) => {
      const declarations =
        css(sheet)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .match(/(?<![a-z-])(?:padding|margin|gap|row-gap|column-gap)[a-z-]*:[^;{}]+;/g) ?? [];
      const off = declarations.filter((declaration) => {
        const property = declaration.split(":")[0] ?? "";
        const lengths = declaration.replace(/var\([^)]*\)/g, "").match(/\d*\.?\d+(?=px)/g) ?? [];
        return lengths.some((px) => offScale(property, Number(px)));
      });
      expect(off).toEqual([]);
    },
  );
});
