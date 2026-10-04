import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("answers health with the database reachable", async () => {
  const res = await exports.default.fetch("https://ocra.test/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("answers unknown API paths with JSON 404", async () => {
  const res = await exports.default.fetch("https://ocra.test/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
