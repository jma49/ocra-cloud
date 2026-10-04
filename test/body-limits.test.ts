import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, JSON_TYPE, resetDb, signIn } from "./helpers.js";

// Audit S-hard (#15): every body is counted as it arrives, so a chunked
// request without a content-length is bounded too, and reading stops as
// soon as it passes the limit.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const MB = 1024 * 1024;

/** A body sent in chunks with no content-length; `pulled` counts bytes read. */
function chunked(text: string, chunk = 16 * 1024) {
  const bytes = new TextEncoder().encode(text);
  const state = { pulled: 0 };
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const part = bytes.subarray(at, at + chunk);
      at += part.length;
      state.pulled += part.length;
      controller.enqueue(part);
    },
  });
  return { body, state };
}

/** Valid JSON of about `size` bytes, so only its size can refuse it. */
const padded = (size: number, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...fields, pad: "x".repeat(size) });

describe("streamed request bodies", () => {
  it("the gateway stops reading a chunked body past 8 MB", async () => {
    const { auth } = await signIn(1, "octo");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    const put = await call("/api/keys/openrouter", {
      method: "PUT",
      auth: auth,
      json: { key: "sk-or-v1-0123456789abcdef" },
    });
    expect(put.status).toBe(200);
    fetchSpy.mockClear();
    const { body, state } = chunked(padded(20 * MB, { model: "m" }), MB);
    const res = await call("/api/gateway/openrouter/v1/chat/completions", {
      method: "POST",
      auth,
      headers: JSON_TYPE,
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
    // Read up to the limit and one chunk past it, not the whole 20 MB.
    expect(state.pulled).toBeLessThanOrEqual(10 * MB);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every other route that reads a body refuses one past its limit", async () => {
    const { auth } = await signIn(2, "hubot");
    const routes: [string, string, number][] = [
      ["DELETE", "/api/account", 64 * 1024],
      ["PUT", "/api/account/sharing", 64 * 1024],
      ["PUT", "/api/keys/openrouter", 64 * 1024],
      ["POST", "/api/memory", 64 * 1024],
      ["PUT", "/api/preferences", 64 * 1024],
      ["POST", "/api/reviews", 600_000],
      ["POST", "/api/device/code", 64 * 1024],
      ["POST", "/api/device/decide", 64 * 1024],
      ["POST", "/api/device/token", 64 * 1024],
      ["POST", "/api/device/refresh", 64 * 1024],
    ];
    for (const [method, path, limit] of routes) {
      const text = padded(limit);
      const headers = { ...auth, ...JSON_TYPE, "cf-connecting-ip": path };
      // Chunked, with no content-length to go by.
      const { body } = chunked(text);
      const streamed = await call(path, { method, headers, body });
      expect([path, streamed.status], "chunked").toEqual([path, 413]);
      // And with an honest content-length.
      const plain = await call(path, { method, headers, body: text });
      expect([path, plain.status], "declared").toEqual([path, 413]);
    }
    // A body under the limit still reads.
    const ok = await call("/api/account/sharing", {
      method: "PUT",
      auth,
      headers: JSON_TYPE,
      body: chunked(JSON.stringify({ enabled: false })).body,
    });
    expect(ok.status).toBe(200);
  });
});
