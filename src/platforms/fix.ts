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
 * Why a fix was left out of a file: `stale` when its lines are not as it
 * expects them, `not_applicable` when the file is not UTF-8 text, is too
 * large, has no such lines, or an earlier fix in the list overlaps them.
 */
export type FixSkip = "stale" | "not_applicable";

/**
 * The file with each fix that can be applied, in its own line endings, and
 * per fix why it was left out (null when applied). Of overlapping fixes the
 * first in the list is applied. undefined when no fix was applied.
 */
export function fixEach(
  bytes: Uint8Array | undefined,
  fixes: readonly LineFix[],
): { content: Uint8Array | undefined; skipped: (FixSkip | null)[] } {
  const text = bytes && textOf(bytes);
  if (!text) return { content: undefined, skipped: fixes.map(() => "not_applicable") };
  const { lines, eol, bom } = text;
  const kept: LineFix[] = [];
  const skipped = fixes.map((fix): FixSkip | null => {
    if (fix.startLine < 1 || fix.endLine < fix.startLine || fix.endLine > text.count) {
      return "not_applicable";
    }
    if (kept.some((k) => k.startLine <= fix.endLine && fix.startLine <= k.endLine)) {
      return "not_applicable";
    }
    const found = lines.slice(fix.startLine - 1, fix.endLine);
    if (fix.expected && !sameLines(found, fix.expected)) return "stale";
    kept.push(fix);
    return null;
  });
  if (kept.length === 0) return { content: undefined, skipped };
  // From the bottom up, so each fix's line numbers still hold when it is applied.
  for (const fix of kept.sort((a, b) => b.startLine - a.startLine)) {
    lines.splice(
      fix.startLine - 1,
      fix.endLine - fix.startLine + 1,
      ...replacementLines(fix.replacement),
    );
  }
  const body = new TextEncoder().encode(lines.join(eol));
  if (!bom) return { content: body, skipped };
  const content = new Uint8Array(BOM.length + body.byteLength);
  content.set(BOM);
  content.set(body, BOM.length);
  return { content, skipped };
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
