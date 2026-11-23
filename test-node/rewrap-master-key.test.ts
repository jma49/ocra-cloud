import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret, keyBinding } from "../src/crypto.js";
import { githubIdentity, upsertAccount } from "../src/db/accounts.js";
import type { Db } from "../src/db/client.js";
import { type Scoped, scoped } from "../src/db/scoped.js";
import { keyFor } from "../src/keyring.js";
import { openHook, sealHook } from "../src/notify/notify.js";
import { accessToken, saveToken } from "../src/platforms/links.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import { openRepoToken, sealRepoToken } from "../src/platforms/repo-token.js";

// scripts/rewrap-master-key.ts run as the maintainer runs it, against a
// SQLite file made by the D1 migrations: `npx wrangler d1 execute` is a
// stand-in on PATH that runs the script's SQL on that file. A row of every
// sealed kind is sealed under the old key; after the script, each opens
// with the new key alone.

const keyOf = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const OLD = keyOf(1);
const NEW = keyOf(2);
const SECRETS = {
  provider: "sk-provider-secret-value",
  platform: "gho_platform-secret-value",
  repo: "glpat-repo-secret-value",
  slackDm: JSON.stringify({ user: "U0SECRET01", channel: "D0SECRET01" }),
  webhook: "https://hooks.example.com/secret-path",
};
const github = { kind: "github", host: "github.com" } as CodePlatform;

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
let data: Scoped;
let repoId: string;
let dmId: string;
let laterId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ocra-rewrap-"));
  writeFileSync(join(dir, "old"), OLD, { mode: 0o600 });
  writeFileSync(join(dir, "new"), NEW, { mode: 0o600 });
  writeFileSync(join(dir, "npx"), FAKE_WRANGLER);
  chmodSync(join(dir, "npx"), 0o755);
  client = createClient({ url: `file:${join(dir, "d1.sqlite")}` });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: resolve("migrations") });
  const account = await upsertAccount(db as unknown as Db, githubIdentity(1), "octo");
  data = scoped(db as unknown as Db, account.id);

  await data.insert("providerKeys", {
    provider: "openrouter",
    ...(await encryptSecret(OLD, SECRETS.provider, keyBinding(account.id, "openrouter"))),
    last4: "alue",
  });
  await saveToken(data, { MASTER_KEY: OLD }, github, { access_token: SECRETS.platform });
  repoId = await data.insert("reviewRepos", {
    platform: "gitlab",
    host: "gitlab.com",
    platformRepoId: "11",
    fullName: "acme/api",
  });
  const sealed = await sealRepoToken(OLD, { accountId: account.id, id: repoId }, SECRETS.repo);
  await data.update("reviewRepos", repoId, {
    accessTokenWrappedKey: sealed.wrappedKey,
    accessTokenCiphertext: sealed.ciphertext,
  });
  // A repository without a token of its own is left as it is.
  await data.insert("reviewRepos", {
    platform: "gitlab",
    host: "gitlab.com",
    platformRepoId: "12",
    fullName: "acme/web",
  });
  const channel = async (kind: "slack_dm" | "webhook", key: string, address: string) => {
    const id = await data.insert("notifyChannels", {
      kind,
      name: kind,
      when: "every",
      wrappedKey: "w",
      ciphertext: "c",
      last4: "abcd",
    });
    await data.update("notifyChannels", id, await sealHook(key, account.id, id, address));
    return id;
  };
  dmId = await channel("slack_dm", OLD, SECRETS.slackDm);
  // Saved by the service during the rotation, already under the new key.
  laterId = await channel("webhook", NEW, SECRETS.webhook);
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

async function openedWithNewKeyOnly() {
  const only = { current: NEW };
  const repo = await data.get("reviewRepos", repoId);
  const dm = await data.get("notifyChannels", dmId);
  const later = await data.get("notifyChannels", laterId);
  return {
    provider: await keyFor(data, only, "openrouter").catch(() => null),
    platform: await accessToken(data, { MASTER_KEY: NEW }, github),
    repo: repo ? await openRepoToken(only, repo) : null,
    slackDm: dm ? await openHook(only, dm) : null,
    webhook: later ? await openHook(only, later) : null,
  };
}

describe("rotating the master key", () => {
  it("re-wraps a row of every sealed kind, so that each opens with the new key", async () => {
    const checked = rewrap("--local");
    expect(checked.code).toBe(0);
    expect(checked.output).toContain("Checked only");

    const applied = rewrap("--local", "--apply");
    expect(applied.code).toBe(0);
    expect(await openedWithNewKeyOnly()).toEqual(SECRETS);
    expect(applied.output).toContain("Every sealed row opens with the new key");
    for (const secret of [OLD, NEW, ...Object.values(SECRETS)]) {
      expect(applied.output).not.toContain(secret);
    }
  });

  it("changes nothing when run again", async () => {
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
    const sealed = (provider: string, key: string) =>
      encryptSecret(key, `sk-${provider}`, keyBinding(data.accountId, provider));
    await data.insert("providerKeys", {
      provider: "deepseek",
      ...(await sealed("deepseek", OLD)),
      last4: "seek",
    });
    await data.insert("providerKeys", {
      provider: "anthropic",
      ...(await sealed("anthropic", keyOf(3))),
      last4: "opic",
    });
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
