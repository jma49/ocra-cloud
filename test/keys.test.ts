import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, keyBinding } from "../src/crypto.js";
import { scoped } from "../src/db/scoped.js";
import { checkKey, listModels, verifyRoutes } from "../src/providers.js";
import { call, db, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const json = { "content-type": "application/json" };
const answer = (status: number, body = "{}") =>
  vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async () => new Response(body, { status }));

describe("checking a key", () => {
  it("asks the provider's key-checking route with the key", async () => {
    const fake = answer(200);
    expect(await checkKey("anthropic", "sk-ant-x")).toEqual({ status: "ok", httpStatus: 200 });
    const [input, init] = fake.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.anthropic.com/v1/models");
    const h = new Headers(init?.headers);
    expect(h.get("x-api-key")).toBe("sk-ant-x");
    expect(h.get("anthropic-version")).toBeTruthy();
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("tells a rejected key from other failures", async () => {
    answer(401);
    expect((await checkKey("openai", "k")).status).toBe("invalid");
    answer(403);
    expect((await checkKey("openai", "k")).status).toBe("invalid");
    answer(400, '{"error":{"message":"API key not valid"}}');
    expect((await checkKey("gemini", "k")).status).toBe("invalid");
    answer(400, '{"error":"bad model"}');
    expect((await checkKey("gemini", "k")).status).toBe("error");
    answer(503);
    expect(await checkKey("openai", "k")).toEqual({ status: "error", httpStatus: 503 });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await checkKey("openai", "k")).toEqual({ status: "error" });
  });

  it("does not follow a redirect with the key (#15)", async () => {
    const fake = answer(302);
    expect(await checkKey("openai", "k")).toEqual({ status: "error", httpStatus: 302 });
    expect(await listModels("openai", "k")).toEqual([]);
    expect(fake.mock.calls.map(([, init]) => init?.redirect)).toEqual(["manual", "manual"]);
  });

  it("does not check providers that list models without a key", async () => {
    const fake = answer(200);
    expect("huggingface" in verifyRoutes).toBe(false);
    expect(await checkKey("huggingface", "k")).toEqual({ status: "unchecked" });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("keys API", () => {
  it("stores a key bound to its account and provider", async () => {
    const me = await signIn(1, "me");
    answer(200);
    await call("/api/keys/openai", {
      method: "PUT",
      headers: { ...me.auth, ...json },
      body: JSON.stringify({ key: "sk-bound-12345" }),
    });
    const [row] = await scoped(db, me.account.id).list("providerKeys");
    if (!row) throw new Error("no row");
    const master = env.MASTER_KEY;
    expect(await decryptSecret(master, row, keyBinding(me.account.id, "openai"))).toBe(
      "sk-bound-12345",
    );
    await expect(decryptSecret(master, row)).rejects.toThrow();
    await expect(
      decryptSecret(master, row, keyBinding("someone-else", "openai")),
    ).rejects.toThrow();
  });

  it("checks a key when it is saved and on request, and reports use", async () => {
    const me = await signIn(1, "me");
    answer(401);
    const put = await call("/api/keys/openai", {
      method: "PUT",
      headers: { ...me.auth, ...json },
      body: JSON.stringify({ key: "sk-wrong-12345" }),
    });
    expect(await put.json()).toMatchObject({ check: { status: "invalid" } });

    answer(200);
    const test = await call("/api/keys/openai/test", { method: "POST", headers: me.auth });
    expect(await test.json()).toMatchObject({ check: { status: "ok" } });

    await scoped(db, me.account.id).insert("gatewayCalls", {
      id: "g1",
      provider: "openai",
      path: "/v1/chat/completions",
      status: 200,
    });
    const list = (await (await call("/api/keys", { headers: me.auth })).json()) as {
      keys: {
        provider: string;
        checkStatus: string;
        checkable: boolean;
        calls7d: number;
        lastUsedAt: string;
      }[];
    };
    expect(list.keys).toMatchObject([
      { provider: "openai", checkStatus: "ok", checkable: true, calls7d: 1 },
    ]);
    expect(list.keys[0]?.lastUsedAt).toBeTruthy();
  });

  it("tests only the caller's own key", async () => {
    const me = await signIn(1, "me");
    const other = await signIn(2, "other");
    answer(200);
    await call("/api/keys/openai", {
      method: "PUT",
      headers: { ...me.auth, ...json },
      body: JSON.stringify({ key: "sk-mine-12345" }),
    });
    const res = await call("/api/keys/openai/test", { method: "POST", headers: other.auth });
    expect(res.status).toBe(404);
  });
});
