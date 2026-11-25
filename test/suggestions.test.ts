import { describe, expect, it } from "vitest";
import { fixEach, type LineFix } from "../src/platforms/fix.js";
import {
  githubSuggestions,
  newSideTail,
  suggestionLineCount,
  withSuggestion,
} from "../src/platforms/suggestions.js";

// Review suggestions as each platform writes and reads them in Markdown, and
// several applied to one file together.

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const applyAll = (bytes: Uint8Array, fixes: LineFix | readonly LineFix[]) => {
  const each = fixEach(bytes, [fixes].flat());
  return each.skipped.every((s) => s === null) ? each.content : undefined;
};

describe("writing a suggestion", () => {
  it("puts GitHub's block after the comment, and GitLab's with the lines above it", () => {
    expect(withSuggestion("github", "Use a constant.", "const b = 2;\n", 3)).toBe(
      "Use a constant.\n\n```suggestion\nconst b = 2;\n```",
    );
    expect(withSuggestion("gitlab", "", "x\r\ny", 2)).toBe("```suggestion:-2+0\nx\ny\n```");
    expect(withSuggestion("gitlab", "Drop it", "", 0)).toBe("Drop it\n\n```suggestion\n```");
  });

  it("fences a suggestion that holds a fence of its own with a longer one", () => {
    const body = withSuggestion("github", "", "```ts\nx\n```", 0);
    expect(body).toBe("````suggestion\n```ts\nx\n```\n````");
    expect(githubSuggestions(body)).toEqual(["```ts\nx\n```"]);
  });

  it("counts a suggestion's lines", () => {
    expect(suggestionLineCount("")).toBe(0);
    expect(suggestionLineCount("a\nb\n")).toBe(2);
  });
});

describe("reading GitHub suggestions", () => {
  it("reads each closed block, an empty one included", () => {
    expect(githubSuggestions("Nit:\r\n```suggestion\r\nconst x = 1;\r\n```\r\n")).toEqual([
      "const x = 1;",
    ]);
    expect(githubSuggestions("```suggestion\n```\n~~~suggestion\na\n~~~")).toEqual(["", "a"]);
  });

  it("reads no other code block, and no unclosed one", () => {
    expect(githubSuggestions("```ts\nx\n```")).toEqual([]);
    expect(githubSuggestions("```suggestion\nx\n")).toEqual([]);
    expect(githubSuggestions("```suggestion:-1+0\nx\n```")).toEqual([]);
  });

  it("takes the lines a comment was written on from the end of its hunk's new side", () => {
    const hunk = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";
    expect(newSideTail(hunk, 2)).toEqual(["B", "c"]);
    expect(newSideTail(hunk, 4)).toBeUndefined();
  });
});

describe("several fixes of one file", () => {
  it("applies them together, from the bottom up", () => {
    const out = applyAll(encode("a\nb\nc\nd\n"), [
      { startLine: 1, endLine: 1, replacement: "A\nA2" },
      { startLine: 3, endLine: 4, replacement: "" },
    ]);
    expect(decode(out)).toBe("A\nA2\nb\n");
  });

  it("refuses fixes that overlap", () => {
    const fixes = [
      { startLine: 1, endLine: 2, replacement: "x" },
      { startLine: 2, endLine: 3, replacement: "y" },
    ];
    expect(applyAll(encode("a\nb\nc\n"), fixes)).toBeUndefined();
  });

  it("refuses a fix whose lines changed since it was written", () => {
    const file = encode("a\r\nb\r\n");
    const fix = { startLine: 2, endLine: 2, replacement: "B" };
    expect(decode(applyAll(file, { ...fix, expected: ["b\r"] }))).toBe("a\r\nB\r\n");
    expect(applyAll(file, { ...fix, expected: ["c"] })).toBeUndefined();
  });
});
