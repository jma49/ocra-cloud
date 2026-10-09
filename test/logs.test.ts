import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { call, resetDb, signIn } from "./helpers.js";

// Audit C10: a failed request is logged as one JSON object Workers Logs can
// search by field, with Cloudflare's ray id to find it again, and nothing
// of the request's token or the error's text.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

it("logs an internal error as a structured event with the request's ray id", async () => {
  const me = await signIn(1, "octo");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(env.DB, "prepare").mockImplementation(() => {
    throw new Error("D1 said: sk-secret-123");
  });
  const res = await call("/api/me", { auth: me.auth, headers: { "cf-ray": "8f00ba11-LHR" } });
  vi.mocked(env.DB.prepare).mockRestore();
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "internal" });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toEqual([
    {
      level: "error",
      event: "api_error",
      requestId: "8f00ba11-LHR",
      method: "GET",
      route: "/api/me/*",
      error: "Error",
    },
  ]);
  const logged = JSON.stringify(log.mock.calls);
  expect(logged).not.toContain("sk-secret");
  expect(logged).not.toContain(me.token);
});
