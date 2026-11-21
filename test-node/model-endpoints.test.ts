import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { startCliSession, startWebSession } from "../src/session.js";

// A company's own model endpoint on a self-hosted server: declared by the
// operator, called through the gateway with the server's key, and the only
// provider there is when the public ones are off.

const ORIGIN = "http://ocra.test";
const UPSTREAM = "http://llm.corp.internal:8000/openai";
const SERVER_KEY = "corp-server-key-123";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
  BUILTIN_PROVIDERS: "off",
  MODEL_ENDPOINTS: JSON.stringify([
    { id: "corp", label: "Corp LLM", base: UPSTREAM, models: "/v1/models", key: SERVER_KEY },
    { id: "lab", label: "Lab LLM", base: "https://lab.corp.internal" },
  ]),
  DEFAULT_MODELS: JSON.stringify({ top: ["ocra-corp/qwen3-coder"], light: "ocra-corp/qwen3-8b" }),
};

let dir: string;
let host: Awaited<ReturnType<typeof openHost>>;
let cli: Record<string, string>;
let web: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-endpoints-"));
  host = await openHost({
    databaseUrl: `file:${join(dir, "ocra.db")}`,
    bindings: bindingsFrom(VARS),
    migrations: resolve("migrations"),
  });
  const account = await upsertAccount(host.db, githubIdentity(1), "ada");
  cli = {
    authorization: `Bearer ${(await startCliSession(host.db, account.id, "t")).access_token}`,
  };
  web = { authorization: `Bearer ${await startWebSession(host.db, account.id)}` };
});

afterAll(async () => {
  host?.close();
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

const call = (path: string, init: RequestInit = {}) => host.fetch(new Request(ORIGIN + path, init));

/** Answers the company endpoint's requests; nothing else is reachable. */
function upstream() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${UPSTREAM}/v1/chat/completions`) {
      return Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    }
    if (url === `${UPSTREAM}/v1/models`) return Response.json({ data: [{ id: "qwen3-coder" }] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("a company's own model endpoints", () => {
  it("are what the server lists when the public providers are off", async () => {
    const listed = (await (await call("/api/providers")).json()) as {
      providers: { name: string; group: string; managed?: boolean; paths: string[] }[];
    };
    expect(listed.providers).toEqual([
      expect.objectContaining({
        name: "corp",
        group: "Company",
        managed: true,
        paths: ["/v1/chat/completions"],
      }),
      expect.objectContaining({ name: "lab", group: "Company" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(SERVER_KEY);
  });

  it("forward a call with the server's key, metered like any other", async () => {
    const fake = upstream();
    const res = await call("/api/gateway/corp/v1/chat/completions", {
      method: "POST",
      headers: { ...cli, "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3-coder", messages: [] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const [input, init] = fake.mock.calls[0] ?? [];
    expect(String(input)).toBe(`${UPSTREAM}/v1/chat/completions`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SERVER_KEY}`);
    const keys = (await (await call("/api/keys", { headers: web })).json()) as {
      keys: { provider: string; managed: boolean; last4: string | null }[];
    };
    expect(keys.keys).toEqual([
      expect.objectContaining({ provider: "corp", managed: true, last4: null }),
    ]);
  });

  it("list the models the server's key reaches, and take no key of the user's", async () => {
    upstream();
    const models = await call("/api/keys/corp/models", { headers: web });
    expect(await models.json()).toMatchObject({ models: [{ id: "qwen3-coder" }] });
    const put = await call("/api/keys/corp", {
      method: "PUT",
      headers: { ...web, "content-type": "application/json" },
      body: JSON.stringify({ key: "user-key-12345" }),
    });
    expect(put.status).toBe(404);
    expect(await put.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("want the user's own key where the server holds none", async () => {
    const res = await call("/api/gateway/lab/v1/chat/completions", {
      method: "POST",
      headers: { ...cli, "content-type": "application/json" },
      body: "{}",
    });
    expect(await res.json()).toMatchObject({ error: "no_key", provider: "lab" });
  });

  it("refuse the public providers when they are off", async () => {
    const res = await call("/api/gateway/openai/v1/chat/completions", {
      method: "POST",
      headers: { ...cli, "content-type": "application/json" },
      body: "{}",
    });
    expect(await res.json()).toMatchObject({ error: "unknown_provider" });
  });

  it("stop a server whose declaration is broken from starting", () => {
    expect(() => bindingsFrom({ ...VARS, MODEL_ENDPOINTS: "[{" })).toThrow("not JSON");
  });
});

describe("the server's default models", () => {
  it("are what an account starts with, until it saves its own", async () => {
    const models = async () =>
      (
        (await (await call("/api/preferences/models", { headers: cli })).json()) as {
          models: unknown;
        }
      ).models;
    expect(await models()).toEqual({
      top: ["ocra-corp/qwen3-coder"],
      light: ["ocra-corp/qwen3-8b"],
    });
    const saved = await call("/api/preferences", {
      method: "PUT",
      headers: { ...web, "content-type": "application/json" },
      body: JSON.stringify({ models: { top: ["ocra-lab/glm-4.6"] } }),
    });
    expect(saved.status).toBe(200);
    expect(await models()).toEqual({ top: ["ocra-lab/glm-4.6"] });
  });

  it("stop a server from starting when they name a provider it does not have", () => {
    const named = (model: string) => JSON.stringify({ top: [model] });
    expect(() => bindingsFrom({ ...VARS, DEFAULT_MODELS: named("ocra-openai/gpt-5") })).toThrow(
      "DEFAULT_MODELS cannot be served",
    );
    expect(() => bindingsFrom({ ...VARS, DEFAULT_MODELS: "{" })).toThrow("not JSON");
  });
});
