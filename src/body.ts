import type { Context } from "hono";

// Request bodies are read here, counted as they arrive: a chunked upload
// carries no content-length, so the header alone bounds nothing (#15).

/** What a small JSON request (settings, a key, a device code) may weigh. */
export const SMALL_BODY = 64 * 1024;

/** Thrown past the limit; the app answers 413 body_too_large (src/app.ts). */
export class BodyTooLarge extends Error {
  override name = "BodyTooLarge";
}

/**
 * The body's bytes, read until `max`. A declared length over it is refused
 * before reading; otherwise the stream is cancelled as soon as it passes.
 */
async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw new BodyTooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The body as text, up to `max` bytes. */
export async function readText(c: Context, max: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(c.req.raw, max));
}

/** The body as JSON, up to `max` bytes; null when it is not JSON. */
export async function readJson(c: Context, max = SMALL_BODY): Promise<unknown> {
  const text = await readText(c, max);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
