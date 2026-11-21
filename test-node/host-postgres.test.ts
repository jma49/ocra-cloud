import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import upload from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { startCliSession, startWebSession } from "../src/session.js";

// The self-hosted server on a postgres:// URL, through node-postgres and its
// pool, the migrations of migrations-pg/ and a batch's transaction: a
// Postgres server in this process (PGlite behind its wire protocol).

const ORIGIN = "http://ocra.test";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
};

let pglite: PGlite;
let server: PGLiteSocketServer;
let host: Awaited<ReturnType<typeof openHost>>;
let cli: Record<string, string>;
let web: Record<string, string>;

beforeAll(async () => {
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
  const port = Number(server.getServerConn().split(":").at(-1));
  host = await openHost({
    databaseUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
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
  await server?.stop();
  await pglite?.close();
});

const call = (path: string, init: RequestInit = {}) => host.fetch(new Request(ORIGIN + path, init));
const json = { "content-type": "application/json", origin: ORIGIN };

describe("the self-hosted server on Postgres", () => {
  it("stores an upload with its findings in order, once", async () => {
    const sharing = await call("/api/account/sharing", {
      method: "PUT",
      headers: { ...web, ...json },
      body: JSON.stringify({ enabled: true }),
    });
    expect(sharing.status).toBe(200);
    const send = () =>
      call("/api/reviews", {
        method: "POST",
        headers: { ...cli, ...json },
        body: JSON.stringify(upload),
      });
    const first = (await (await send()).json()) as { id: string; findings: number };
    expect(first.findings).toBe(upload.findingList.length);
    expect(await (await send()).json()).toEqual({ id: first.id, duplicate: true });
    const detail = (await (await call(`/api/reviews/${first.id}`, { headers: web })).json()) as {
      findings: { fingerprint: string }[];
    };
    expect(detail.findings.map((f) => f.fingerprint)).toEqual(
      upload.findingList.map((f) => f.fingerprint),
    );
  });

  it("deletes an account with everything it owns", async () => {
    const res = await call("/api/account", {
      method: "DELETE",
      headers: { ...web, ...json },
      body: JSON.stringify({ confirm: "ada" }),
    });
    expect(res.status).toBe(200);
    const left = await pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM reviews");
    expect(left.rows[0]?.n).toBe(0);
  });
});
