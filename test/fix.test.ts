import { describe, expect, it } from "vitest";
import {
  fixEach,
  fixedFile,
  fixMessage,
  fromBase64,
  linesAt,
  MAX_FIX_FILE_BYTES,
  toBase64,
} from "../src/platforms/fix.js";
import { replacementLines } from "../src/shared/index.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const fixed = (text: string, startLine: number, endLine: number, replacement: string) =>
  decode(fixedFile(encode(text), { startLine, endLine, replacement }));

describe("a fix applied to a file", () => {
  it("replaces its lines, with more or fewer lines than it had", () => {
    expect(fixed("a\nb\nc\n", 2, 2, "B")).toBe("a\nB\nc\n");
    expect(fixed("a\nb\nc\n", 1, 2, "x\ny\nz")).toBe("x\ny\nz\nc\n");
    expect(fixed("a\nb\nc", 3, 3, "C\n")).toBe("a\nb\nC");
  });

  it("deletes its lines when the replacement is empty", () => {
    expect(fixed("a\nb\nc\n", 2, 3, "")).toBe("a\n");
  });

  it("keeps the file's line endings and byte order mark", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const file = new Uint8Array([...bom, ...encode("a\r\nb\r\n")]);
    const out = fixedFile(file, { startLine: 1, endLine: 1, replacement: "x\ny" });
    expect(out).toEqual(new Uint8Array([...bom, ...encode("x\r\ny\r\nb\r\n")]));
  });

  it("changes nothing when the lines are not in the file, or it is not text", () => {
    expect(fixed("a\nb\n", 3, 3, "c")).toBeUndefined();
    expect(fixed("a\nb\n", 2, 1, "c")).toBeUndefined();
    expect(
      fixedFile(new Uint8Array([0xff, 0xfe, 0x00]), { startLine: 1, endLine: 1, replacement: "" }),
    ).toBeUndefined();
    const big = new Uint8Array(MAX_FIX_FILE_BYTES + 1).fill(0x61);
    expect(fixedFile(big, { startLine: 1, endLine: 1, replacement: "" })).toBeUndefined();
  });
});

describe("several fixes applied to a file, each where it can be", () => {
  it("applies those that can be, and says why each other one was left out", () => {
    const { content, skipped } = fixEach(encode("a\nb\nc\nd\n"), [
      { startLine: 4, endLine: 4, replacement: "D" },
      { startLine: 2, endLine: 2, replacement: "B", expected: ["changed"] },
      { startLine: 1, endLine: 1, replacement: "A", expected: ["a"] },
      { startLine: 4, endLine: 5, replacement: "past the end" },
      { startLine: 3, endLine: 4, replacement: "overlaps the first" },
    ]);
    expect(decode(content)).toBe("A\nb\nc\nD\n");
    expect(skipped).toEqual([null, "stale", null, "not_applicable", "not_applicable"]);
  });

  it("changes nothing in a file that is not text", () => {
    expect(
      fixEach(new Uint8Array([0xff]), [{ startLine: 1, endLine: 1, replacement: "" }]),
    ).toEqual({ content: undefined, skipped: ["not_applicable"] });
  });
});

describe("the lines a fix replaces, and with what", () => {
  it("reads its range in the file's own line endings, past a byte order mark", () => {
    expect(linesAt(encode("a\nb\nc\n"), { startLine: 2, endLine: 3 })).toEqual(["b", "c"]);
    expect(linesAt(encode("a\r\nb\r\n"), { startLine: 1, endLine: 1 })).toEqual(["a"]);
    expect(linesAt(encode("\uFEFFa\nb"), { startLine: 1, endLine: 2 })).toEqual(["a", "b"]);
  });

  it("reads nothing past the file's end, from a range that is not one, or from binary", () => {
    expect(linesAt(encode("a\n"), { startLine: 1, endLine: 2 })).toBeUndefined();
    expect(linesAt(encode("a\n"), { startLine: 2, endLine: 1 })).toBeUndefined();
    expect(linesAt(new Uint8Array([0xff, 0xfe]), { startLine: 1, endLine: 1 })).toBeUndefined();
  });

  it("splits a replacement the way a commit of it writes it", () => {
    expect(replacementLines("")).toEqual([]);
    expect(replacementLines("x\r\ny\n")).toEqual(["x", "y"]);
    expect(replacementLines("\n")).toEqual([""]);
  });
});

describe("a fix's commit message", () => {
  it("is one line of the title, without control characters, at most 72 characters", () => {
    expect(fixMessage("Close the\nfile\u0007")).toBe("Apply ocra's fix: Close the file");
    const long = fixMessage("😀".repeat(100));
    expect([...long]).toHaveLength(72);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("base64", () => {
  it("round-trips bytes, and reads GitHub's wrapped lines", () => {
    const bytes = encode("héllo\nwörld");
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(decode(fromBase64("aGVs\nbG8=\n"))).toBe("hello");
    expect(fromBase64("not base64!")).toBeUndefined();
  });
});
