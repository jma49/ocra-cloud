import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { startCliSession } from "../src/session.js";

// SIGN_IN_ALLOW on a self-hosted server whose company model endpoint has the
// server's own key: read from the environment, checked at start, and what
// keeps an account nobody listed off the gateway.

const ORIGIN = "http://ocra.test";
const UPSTREAM = "http://llm.corp.internal:8000/openai";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
  BUILTIN_PROVIDERS: "off",
  MODEL_ENDPOINTS: JSON.stringify([
    { id: "corp", label: "Corp LLM", base: UPSTREAM, key: "corp-server-key" },
  ]),
};

describe("SIGN_IN_ALLOW in the environment", () => {
  it("stops the server at start when an entry cannot be read", () => {
    for (const bad of ["octo", "org:", "team:eng", "domain:a/b", "domain:localhost", "user:a b"]) {
      expect(() => bindingsFrom({ ...VARS, SIGN_IN_ALLOW: bad }), bad).toThrow(/SIGN_IN_ALLOW/);
    }
  });
});

describe("a self-hosted server with SIGN_IN_ALLOW", () => {
  let dir: string;
  let host: Awaited<ReturnType<typeof openHost>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ocra-allow-"));
    host = await openHost({
      databaseUrl: `file:${join(dir, "ocra.db")}`,
      bindings: bindingsFrom({ ...VARS, SIGN_IN_ALLOW: "user:Ada" }),
      migrations: resolve("migrations"),
    });
  });

  afterAll(async () => {
    host?.close();
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  const gatewayCall = async (login: string, githubId: number) => {
    const account = await upsertAccount(host.db, githubIdentity(githubId), login);
    const { access_token } = await startCliSession(host.db, account.id, "t");
    return host.fetch(
      new Request(`${ORIGIN}/api/gateway/corp/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
    );
  };

  it("keeps an account it does not list off the server's model key", async () => {
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const res = await gatewayCall("mallory", 2);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated", reason: "sign_in_not_allowed" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("forwards for an account it lists", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const res = await gatewayCall("ada", 1);
    expect(res.status).toBe(200);
    await res.text();
  });
});
