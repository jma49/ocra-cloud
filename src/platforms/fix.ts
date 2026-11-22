// A finding's fix applied to the file it is in, as the console commits it to
// the pull request: the file at the reviewed head, its lines startLine to
// endLine replaced. Only text the fix can be applied to exactly is changed.

export type LineFix = { startLine: number; endLine: number; replacement: string };

/** The platforms' content APIs take files up to 1 MB. */
export const MAX_FIX_FILE_BYTES = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const BOM = [0xef, 0xbb, 0xbf];

/**
 * The file with the fix in its own line endings, or undefined when it is not
 * UTF-8 text, is too large, or has no such lines.
 */
export function fixedFile(bytes: Uint8Array, fix: LineFix): Uint8Array | undefined {
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
  const endsWithEol = lines.at(-1) === "";
  const count = endsWithEol ? lines.length - 1 : lines.length;
  if (fix.startLine < 1 || fix.endLine < fix.startLine || fix.endLine > count) return undefined;
  const replacement = fix.replacement.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const added = fix.replacement === "" ? [] : replacement.split("\n");
  lines.splice(fix.startLine - 1, fix.endLine - fix.startLine + 1, ...added);
  const body = new TextEncoder().encode(lines.join(eol));
  if (!bom) return body;
  const out = new Uint8Array(BOM.length + body.byteLength);
  out.set(BOM);
  out.set(body, BOM.length);
  return out;
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
