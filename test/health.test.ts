import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import app from "../src/index.js";

it("answers health without touching the database (audit C1)", async () => {
  const DB = new Proxy(env.DB, {
    get() {
      throw new Error("health reached D1");
    },
  });
  const res = await app.fetch(
    new Request("https://ocra.test/api/health"),
    { ...env, DB },
    createExecutionContext(),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("answers unknown API paths with JSON 404", async () => {
  const res = await exports.default.fetch("https://ocra.test/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
