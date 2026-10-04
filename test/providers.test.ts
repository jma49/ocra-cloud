import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthStyle, matchRoute, providers } from "../src/providers.js";
import { call, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const KEY = "test-key-0123456789";

// A concrete path for each route: patterns get a Gemini model name.
const cases = Object.entries(providers).flatMap(([name, p]) =>
  p.routes.map((r) => ({
    name,
    path:
      typeof r.path === "string" ? r.path : "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    auth: r.auth as AuthStyle,
    base: p.base,
  })),
);

describe("every provider route", () => {
  it.each(cases)(
    "$name $path goes to its base with $auth auth",
    async ({ name, path, auth, base }) => {
      const user = await signIn(1, "u");
      const put = await call(`/api/keys/${name}`, {
        method: "PUT",
        headers: { ...user.auth, "content-type": "application/json" },
        body: JSON.stringify({ key: KEY }),
      });
      expect(put.status).toBe(200);
      const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
      const res = await call(`/api/gateway/${name}${path}?alt=sse&key=leak`, {
        method: "POST",
        headers: { ...user.auth, "content-type": "application/json" },
        body: '{"model":"m","messages":[]}',
      });
      expect(res.status).toBe(200);
      const [input, init] = fake.mock.calls[0] ?? [];
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(base + path);
      // Only the route's own query parameters go upstream.
      expect(url.searchParams.get("key")).toBeNull();
      expect(url.searchParams.has("alt")).toBe(auth === "goog");
      const h = new Headers(init?.headers);
      const sent = {
        bearer: h.get("authorization"),
        apiKey: h.get("x-api-key"),
        goog: h.get("x-goog-api-key"),
      };
      expect(sent).toEqual({
        bearer: auth === "bearer" || auth === "both" ? `Bearer ${KEY}` : null,
        apiKey: auth === "x-api-key" || auth === "both" ? KEY : null,
        goog: auth === "goog" ? KEY : null,
      });
    },
  );
});

describe("routes", () => {
  it("every base is https, with no query or trailing slash", () => {
    for (const p of Object.values(providers)) {
      const u = new URL(p.base);
      expect(u.protocol).toBe("https:");
      expect(u.search).toBe("");
      expect(p.base.endsWith("/")).toBe(false);
    }
  });

  it("matches a Gemini model name and refuses anything else in its place", () => {
    const g = providers.gemini;
    expect(matchRoute(g, "/v1beta/models/gemini-2.5-pro:generateContent")?.model).toBe(
      "gemini-2.5-pro",
    );
    for (const bad of [
      "/v1beta/models/../x:generateContent",
      "/v1beta/models/a/b:generateContent",
      "/v1beta/models/m:countTokens",
      "/v1beta/models/m:generateContent/extra",
      "/v1beta/models/%2e%2e:generateContent",
    ]) {
      expect(matchRoute(g, bad)).toBeUndefined();
    }
  });

  it("lists providers publicly, without keys", async () => {
    const res = await call("/api/providers");
    const body = (await res.json()) as { providers: { name: string; paths: string[] }[] };
    expect(body.providers.map((p) => p.name)).toEqual(Object.keys(providers));
    expect(body.providers.find((p) => p.name === "deepseek")?.paths).toContain(
      "/anthropic/v1/messages",
    );
  });
});
