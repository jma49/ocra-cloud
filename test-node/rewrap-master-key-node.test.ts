import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { freshPglite } from "./pglite-cluster.js";
import {
  addUnopenable,
  NEW,
  OLD,
  openedWithNewKeyOnly,
  SECRETS,
  type Sealed,
  sealEveryKind,
} from "./sealed-rows.js";

// A self-hosted server's rotation as its image runs it (`node
// dist/rewrap-master-key.mjs`, built by build:node), with the server's own
// DATABASE_URL, MASTER_KEY (new) and MASTER_KEY_PREVIOUS (old): on a SQLite
// file and on Postgres (PGlite behind its wire protocol).

const entry = resolve("dist/rewrap-master-key.mjs");
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: OLD,
  SESSION_SECRET: "test-session-secret",
};

beforeAll(() => {
  execFileSync("npm", ["run", "--silent", "build:node"], { stdio: "ignore" });
});

type Database = { url: string; close(): Promise<void> };

async function sqliteFile(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), "ocra-rewrap-node-"));
  return {
    url: `file:${join(dir, "ocra.db")}`,
    close: async () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function postgres(): Promise<Database> {
  const pglite: PGlite = await freshPglite();
  const server = new PGLiteSocketServer({
    db: pglite,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 10,
  });
  await server.start();
  const port = Number(server.getServerConn().split(":").at(-1));
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    close: async () => {
      await server.stop();
      await pglite.close();
    },
  };
}

describe.each([
  ["a SQLite file", sqliteFile],
  ["Postgres", postgres],
])("rotating the master key of a self-hosted server on %s", (_, open) => {
  let database: Database;
  let host: Awaited<ReturnType<typeof openHost>>;
  let sealed: Sealed;

  beforeAll(async () => {
    database = await open();
    host = await openHost({
      databaseUrl: database.url,
      bindings: bindingsFrom(VARS),
      migrations: resolve("migrations"),
    });
    sealed = await sealEveryKind(host.db);
  });

  afterAll(async () => {
    host?.close();
    await database?.close();
  });

  const rewrap = (...flags: string[]) =>
    promisify(execFile)(process.execPath, [entry, ...flags], {
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: database.url,
        MASTER_KEY: NEW,
        MASTER_KEY_PREVIOUS: OLD,
      } as unknown as NodeJS.ProcessEnv,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: e.code ?? 1,
        output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      }),
    );

  it("checks without writing, then re-wraps a row of every sealed kind", async () => {
    const { data, repoId } = sealed;
    const before = await data.get("reviewRepos", repoId);
    const checked = await rewrap();
    expect(checked.output).toContain(
      "review_repos: 1 row(s), 1 to re-wrap, 0 already under the new key, 0 failed",
    );
    expect(checked.output).toContain("Checked only");
    expect((await data.get("reviewRepos", repoId))?.accessTokenWrappedKey).toBe(
      before?.accessTokenWrappedKey,
    );

    const applied = await rewrap("--apply");
    expect(applied.output).toContain("Every sealed row opens with the new key");
    expect(applied.code).toBe(0);
    expect(await openedWithNewKeyOnly(sealed)).toEqual(SECRETS);
    for (const secret of [OLD, NEW, ...Object.values(SECRETS)]) {
      expect(applied.output).not.toContain(secret);
    }
  });

  it("changes nothing when run again", async () => {
    const { data, repoId } = sealed;
    const before = await data.get("reviewRepos", repoId);
    const again = await rewrap("--apply");
    expect(again.output).toContain(
      "review_repos: 1 row(s), 0 to re-wrap, 1 already under the new key, 0 failed",
    );
    expect(again.code).toBe(0);
    expect((await data.get("reviewRepos", repoId))?.accessTokenWrappedKey).toBe(
      before?.accessTokenWrappedKey,
    );
  });

  it("fails, and writes nothing, on a row that opens with neither key", async () => {
    const { data } = sealed;
    await addUnopenable(data);
    const before = await data.findOne("providerKeys", { provider: "deepseek" });

    const failed = await rewrap("--apply");

    expect(failed.output).toContain(
      "provider_keys: 3 row(s), 1 to re-wrap, 1 already under the new key, 1 failed",
    );
    expect(failed.code).toBe(1);
    expect((await data.findOne("providerKeys", { provider: "deepseek" }))?.wrappedKey).toBe(
      before?.wrappedKey,
    );
  });
});
