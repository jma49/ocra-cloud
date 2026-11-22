import { REDACTED } from "@open-cr-agent/cloud-contract";
import { replacementLines } from "../shared/index.js";

// A finding's fix applied to the file it is in, as the console commits it to
// the pull request: the file at the reviewed head, its lines startLine to
// endLine replaced. Only text the fix can be applied to exactly is changed.
// Review suggestions go the same way, several to a file in one commit.

export type LineFix = {
  startLine: number;
  endLine: number;
  replacement: string;
  /** The lines as they were when the fix was written; a file where they changed is not fixed. */
  expected?: readonly string[];
};

/** The platforms' content APIs take files up to 1 MB. */
export const MAX_FIX_FILE_BYTES = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const BOM = [0xef, 0xbb, 0xbf];

type Text = { lines: string[]; eol: string; bom: boolean; count: number };

/** The file's lines, or undefined when it is not UTF-8 text or is too large. */
function textOf(bytes: Uint8Array): Text | undefined {
  if (bytes.byteLength > MAX_FIX_FILE_BYTES) return undefined;
  // Kept by hand: not every runtime's decoder honours ignoreBOM.
  const bom = BOM.every((b, i) => bytes[i] === b);
  let text: string;
  try {
    text = decoder.decode(bom ? bytes.subarray(BOM.length) : bytes);
  } catch {
    return undefined;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  return { lines, eol, bom, count };
}

/** Lines startLine to endLine of the file, or undefined when it is not text that has them. */
export function linesAt(
  bytes: Uint8Array,
  range: Pick<LineFix, "startLine" | "endLine">,
): string[] | undefined {
  const text = textOf(bytes);
  if (!text || range.startLine < 1 || range.endLine < range.startLine) return undefined;
  if (range.endLine > text.count) return undefined;
  return text.lines.slice(range.startLine - 1, range.endLine);
}

/**
 * The file with the fixes in its own line endings, or undefined when it is not
 * UTF-8 text, is too large, has no such lines, or the fixes overlap.
 */
export function fixedFile(
  bytes: Uint8Array,
  fixes: LineFix | readonly LineFix[],
): Uint8Array | undefined {
  const text = textOf(bytes);
  if (!text) return undefined;
  const { lines, eol, bom } = text;
  // From the bottom up, so each fix's line numbers still hold when it is applied.
  const ordered = [fixes].flat().sort((a, b) => b.startLine - a.startLine);
  let floor = text.count + 1;
  for (const fix of ordered) {
    if (fix.startLine < 1 || fix.endLine < fix.startLine || fix.endLine >= floor) return undefined;
    floor = fix.startLine;
    const found = lines.slice(fix.startLine - 1, fix.endLine);
    if (fix.expected && !sameLines(found, fix.expected)) return undefined;
    lines.splice(
      fix.startLine - 1,
      fix.endLine - fix.startLine + 1,
      ...replacementLines(fix.replacement),
    );
  }
  const body = new TextEncoder().encode(lines.join(eol));
  if (!bom) return body;
  const out = new Uint8Array(BOM.length + body.byteLength);
  out.set(BOM);
  out.set(body, BOM.length);
  return out;
}

// A diff shows a CRLF file's lines with their CR; the file is split on CRLF.
const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  a.every((line, i) => line.replace(/\r$/, "") === b[i]?.replace(/\r$/, ""));

/** A path inside the repository, by its parts; undefined for one that leaves it or was redacted. */
export function repoFilePath(file: string): string | undefined {
  if (file.includes(REDACTED) || /\p{Cc}/u.test(file)) return undefined;
  const parts = file.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..") ? file : undefined;
}

/** A commit's one-line message for the fix of the finding titled `title`. */
export function fixMessage(title: string): string {
  // Model text: one line, no control characters, short enough for a subject.
  const line = [...title.replace(/\s+/g, " ").trim()]
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && ch !== "\u007f")
    .join("");
  const subject = `Apply ocra's fix: ${line}`;
  const chars = [...subject];
  return chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : subject;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** undefined when it is not base64. */
export function fromBase64(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}
