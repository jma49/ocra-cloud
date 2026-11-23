import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import {
  addUnopenable,
  NEW,
  OLD,
  openedWithNewKeyOnly,
  SECRETS,
  type Sealed,
  sealEveryKind,
} from "./sealed-rows.js";

// scripts/rewrap-master-key.ts run as the maintainer runs it, against a
// SQLite file made by the D1 migrations: `npx wrangler d1 execute` is a
// stand-in on PATH that runs the script's SQL on that file. A row of every
// sealed kind is sealed under the old key; after the script, each opens
// with the new key alone.

// Reads the statement from --command, or the statements from --file; answers as wrangler's --json does.
const FAKE_WRANGLER = `#!/usr/bin/env node
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
if (args[0] !== "wrangler" || !args.includes("--local")) process.exit(3);
const db = new DatabaseSync(process.env.FAKE_D1);
let results = [];
if (args.includes("--command")) results = db.prepare(at("--command")).all();
else db.exec(readFileSync(at("--file"), "utf8"));
process.stdout.write("Executing...\\n" + JSON.stringify([{ results, success: true }]));
`;

let dir: string;
let client: Client;
let sealed: Sealed;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ocra-rewrap-"));
  writeFileSync(join(dir, "old"), OLD, { mode: 0o600 });
  writeFileSync(join(dir, "new"), NEW, { mode: 0o600 });
  writeFileSync(join(dir, "npx"), FAKE_WRANGLER);
  chmodSync(join(dir, "npx"), 0o755);
  client = createClient({ url: `file:${join(dir, "d1.sqlite")}` });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: resolve("migrations") });
  sealed = await sealEveryKind(db as unknown as Db);
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

function rewrap(...flags: string[]) {
  const run = spawnSync(
    process.execPath,
    [
      "scripts/rewrap-master-key.ts",
      "--old",
      join(dir, "old"),
      "--new",
      join(dir, "new"),
      ...flags,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_D1: join(dir, "d1.sqlite"),
        NODE_NO_WARNINGS: "1",
      },
    },
  );
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("rotating the master key", () => {
  it("re-wraps a row of every sealed kind, so that each opens with the new key", async () => {
    const checked = rewrap("--local");
    expect(checked.code).toBe(0);
    expect(checked.output).toContain("Checked only");

    const applied = rewrap("--local", "--apply");
    expect(applied.code).toBe(0);
    expect(await openedWithNewKeyOnly(sealed)).toEqual(SECRETS);
    expect(applied.output).toContain("Every sealed row opens with the new key");
    for (const secret of [OLD, NEW, ...Object.values(SECRETS)]) {
      expect(applied.output).not.toContain(secret);
    }
  });

  it("changes nothing when run again", async () => {
    const { data, repoId } = sealed;
    const before = await data.get("reviewRepos", repoId);
    const again = rewrap("--local", "--apply");
    expect(again.code).toBe(0);
    expect(again.output).toContain(
      "review_repos: 1 row(s), 0 to re-wrap, 1 already under the new key",
    );
    expect((await data.get("reviewRepos", repoId))?.accessTokenWrappedKey).toBe(
      before?.accessTokenWrappedKey,
    );
  });

  it("fails, and writes nothing, on a row that opens with neither key", async () => {
    const { data } = sealed;
    await addUnopenable(data);
    const before = await data.findOne("providerKeys", { provider: "deepseek" });

    const failed = rewrap("--local", "--apply");

    expect(failed.code).toBe(1);
    expect(failed.output).toContain(
      "provider_keys: 3 row(s), 1 to re-wrap, 1 already under the new key, 1 failed",
    );
    expect((await data.findOne("providerKeys", { provider: "deepseek" }))?.wrappedKey).toBe(
      before?.wrappedKey,
    );
  });
});
