import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The server's entry as the image runs it: what a process refuses at start,
// before it serves anything.

let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-server-start-"));
  // Inside the repository, so the bundle finds its packages in node_modules.
  bundle = resolve("dist/start/server.mjs");
  await build({
    entryPoints: ["src/node/server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: bundle,
    logLevel: "silent",
  });
});

afterAll(() => rm(dir, { recursive: true, force: true }));

/** The process's exit code and output. */
const start = (env: Record<string, string>) =>
  promisify(execFile)(process.execPath, [bundle], {
    cwd: resolve("."),
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: `file:${join(dir, "ocra.db")}`,
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
      SESSION_SECRET: "s",
      OIDC_ISSUER: "https://sso.example.com",
      OIDC_CLIENT_ID: "c",
      OIDC_CLIENT_SECRET: "s",
      GITLAB_BOT_TOKEN: "bot",
      ...env,
      // The Worker's typing of process.env names its bindings; a child gets none of them.
    } as unknown as NodeJS.ProcessEnv,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e: { code?: number; stdout: string; stderr: string }) => ({
      code: e.code ?? 1,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );

describe("a server process with a bot", () => {
  it("migrates without PUBLIC_URL, as the one-off migrate run of Compose does", async () => {
    const run = await start({ MIGRATE: "only" });
    expect(run.stderr).not.toContain("PUBLIC_URL");
    expect(run).toMatchObject({ code: 0, stdout: expect.stringContaining("migrated") });
  });

  it("refuses to serve without PUBLIC_URL", async () => {
    expect(await start({})).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("auto review needs PUBLIC_URL"),
    });
  });
});
