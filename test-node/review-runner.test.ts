import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSalt } from "../src/db/accounts.js";
import { scoped } from "../src/db/scoped.js";
import { instructionCheckId } from "../src/merge-checks/instruction.js";
import {
  type Exec,
  runNextGeneration,
  runNextReply,
  runNextReview,
} from "../src/node/review-runner.js";
import type { BotTokens } from "../src/platforms/bot.js";
import { appJwt, botTokens } from "../src/platforms/bot-tokens.js";
import { github } from "../src/platforms/github.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { C1 } from "./graph-fakes.js";
import { graphServer, ORIGIN, type Server } from "./graph-server.js";

// A hosted review's run (ADR-0046, 4-5): the bot's token, a clone in a new
// directory, the released CLI on the pull request signed in as the account,
// and nothing left behind.

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-review-runner-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("the ocra bot's GitHub token", () => {
  it("is minted with an App JWT, for the one repository and a review's permissions", async () => {
    const asked: { url: string; auth: string | null; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      asked.push({
        url: req.url,
        auth: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json() : null,
      });
      if (req.url === "https://api.github.com/app") return Response.json({ slug: "ocra-review" });
      if (req.url === "https://api.github.com/repos/Octo/API/installation") {
        return Response.json({ id: 5 });
      }
      if (req.url === "https://api.github.com/app/installations/5/access_tokens") {
        return Response.json({ token: "ghs_bot" }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    const bot = await botTokens({
      githubApi: GITHUB_COM.api,
      githubAppId: "123",
      githubAppPrivateKey: PEM,
    }).forRepo("github", "Octo/API");
    expect(bot).toEqual({ token: "ghs_bot", login: "ocra-review[bot]" });
    const minted = asked.find((a) => a.url.endsWith("/access_tokens"));
    expect(minted?.body).toEqual({
      repositories: ["API"],
      permissions: { contents: "read", pull_requests: "write", metadata: "read", checks: "write" },
    });
    await botTokens({
      githubApi: GITHUB_COM.api,
      githubAppId: "123",
      githubAppPrivateKey: PEM,
    }).forRepo("github", "Octo/API", "commit");
    const pushing = asked.filter((a) => a.url.endsWith("/access_tokens")).at(-1);
    expect(pushing?.body).toMatchObject({ permissions: { contents: "write" } });
    const jwt = minted?.auth?.replace("Bearer ", "") ?? "";
    const [head, body, signature] = jwt.split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${head}.${body}`);
    expect(verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(body ?? "", "base64url").toString())).toMatchObject({
      iss: "123",
    });
  });

  it("is none without the App's key, or when the App is not on the repository", async () => {
    expect(
      await botTokens({ githubApi: GITHUB_COM.api, githubAppId: "123" }).forRepo(
        "github",
        "Octo/API",
      ),
    ).toBeNull();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(null, { status: 404 }),
    );
    const bots = botTokens({
      githubApi: GITHUB_COM.api,
      githubAppId: "123",
      githubAppPrivateKey: PEM,
    });
    expect(await bots.forRepo("github", "Octo/API")).toBeNull();
    expect(
      await botTokens({ githubApi: GITHUB_COM.api, gitlabBotToken: "glpat-bot" }).forRepo(
        "gitlab",
        "g/p",
      ),
    ).toEqual({
      token: "glpat-bot",
    });
  });

  it("signs a JWT that lives under GitHub's ten minutes", async () => {
    const body = JSON.parse(
      Buffer.from((await appJwt("1", PEM, 1_000_000)).split(".")[1] ?? "", "base64url").toString(),
    );
    expect(body.exp - body.iat).toBeLessThanOrEqual(600);
  });
});

describe("a review job's run", () => {
  let s: Server;
  let accountId: string;
  let repoId: string;
  const bots: BotTokens = {
    forRepo: async () => ({ token: "ghs_bot", login: "ocra-review[bot]" }),
  };
  const platforms = [
    github({ host: GITHUB_COM, id: "self-hosted-app", secret: "test-client-secret" }),
  ];

  beforeEach(async () => {
    s = await graphServer(dir, `runner-${n++}.db`, "off", undefined, {
      bots: { githubApi: GITHUB_COM.api },
      workers: 0,
    });
    const me = await s.signIn(1);
    accountId = me.account.id;
    const jobs = scoped(s.host.db, accountId).autoReview;
    const repo = await jobs.enroll(
      { platform: "github", host: "github.com", platformRepoId: "11", fullName: "Octo/API" },
      100,
    );
    repoId = repo ?? "";
    await jobs.queue(repoId, 7, C1, new Date());
  });
  afterEach(() => s.host.close());

  it("is offered to the console: /me says the server reviews pull requests itself", async () => {
    const { auth } = await s.signIn(2);
    expect(await (await s.call("/api/me", { headers: auth })).json()).toMatchObject({
      autoReview: true,
    });
  });

  type Call = {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
  };
  const fakeExec = (
    cliCode: number,
    seen: {
      credentials?: unknown;
      config?: string;
      ocra?: unknown;
      salt?: string;
      consent?: string;
    },
  ) => {
    const calls: Call[] = [];
    const exec: Exec = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      if (command === "git") {
        await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
        return { code: 0 };
      }
      seen.credentials = JSON.parse(
        await readFile(join(options.env.XDG_CONFIG_HOME ?? "", "ocra", "credentials.json"), "utf8"),
      );
      seen.salt = await readFile(
        join(options.env.XDG_CONFIG_HOME ?? "", "ocra", "upload-salt"),
        "utf8",
      ).catch(() => "");
      seen.consent = await readFile(
        join(options.env.XDG_CONFIG_HOME ?? "", "ocra", "share-findings"),
        "utf8",
      ).catch(() => "");
      seen.config = await readFile(join(options.cwd, ".git", "config"), "utf8");
      seen.ocra = JSON.parse(await readFile(args.at(-1) ?? "", "utf8"));
      return { code: cliCode };
    };
    return { exec, calls };
  };

  const run = (exec: Exec) =>
    runNextReview({
      db: s.host.db,
      platforms,
      bots,
      publicUrl: ORIGIN,
      dailyCalls: 1000,
      exec,
      cli: "/opt/ocra/main.js",
    });

  it("clones, runs the CLI on the pull request as the account and the bot, and leaves nothing", async () => {
    const seen: {
      credentials?: Record<string, unknown>;
      config?: string;
      salt?: string;
      consent?: string;
      ocra?: unknown;
    } = {};
    const { exec, calls } = fakeExec(1, seen);
    expect(await run(exec)).toBe(true);
    // What `ocra login` records on a person's machine: without it the CLI sends counts only.
    expect(seen.consent).toBe("on\n");
    // The account's salt, not one made in the run's new home: the CLI
    // names the repository the same in every run.
    expect(seen.salt).toBe(`${await accountSalt(s.host.db, accountId)}\n`);
    expect(seen.salt).toMatch(/^[0-9a-f]{64}\n$/);

    const [clone, cli] = calls;
    expect(clone?.args).toEqual([
      "clone",
      "--quiet",
      "--no-tags",
      "--",
      "https://github.com/Octo/API.git",
      expect.any(String),
    ]);
    expect(JSON.stringify(clone?.args)).not.toContain("ghs_bot");
    expect(clone?.env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:ghs_bot").toString("base64")}`,
    );
    expect(cli?.args).toEqual([
      "/opt/ocra/main.js",
      "review",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--publish",
      "--no-repo-config",
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
    expect(cli?.env).toMatchObject({ GITHUB_TOKEN: "ghs_bot", OCRA_CLOUD_URL: ORIGIN });
    // None of the server's own secrets reach the child.
    for (const env of [clone?.env, cli?.env]) {
      expect(Object.keys(env ?? {}).sort()).not.toContain("MASTER_KEY");
      expect(Object.keys(env ?? {})).not.toContain("SESSION_SECRET");
    }
    expect(seen.credentials).toMatchObject({ server: ORIGIN, login: "user-1" });
    expect(seen.config).toContain("extraHeader = Authorization: Basic");
    // An account that chose no runtime reviews on Direct, not the CLI's OpenCode.
    expect(seen.ocra).toMatchObject({ runtime: "direct" });

    // The run's directory and its session are gone, the job done.
    expect(existsSync(clone?.args.at(-1) ?? "")).toBe(false);
    const sessions = await scoped(s.host.db, accountId).list("sessions");
    expect(sessions.filter((x) => x.label === "auto review")).toEqual([]);
    const [job] = await scoped(s.host.db, accountId).autoReview.latestJobs();
    expect(job).toMatchObject({ state: "done", attempts: 1 });
  });

  it("leaves the account's fixes setting to the signed-in CLI: the arguments and file are unchanged", async () => {
    const { auth } = await s.signIn(1);
    const saved = await s.call("/api/preferences", {
      method: "PUT",
      headers: auth,
      json: { settings: { fixes: true } },
    });
    expect(saved.status).toBe(200);
    let read: unknown;
    const seen: { ocra?: unknown; credentials?: { access_token?: string } } = {};
    const { exec: base, calls } = fakeExec(0, seen);
    const exec: Exec = async (command, args, options) => {
      const ran = await base(command, args, options);
      if (command !== "git") {
        const res = await s.call("/api/preferences", {
          headers: { authorization: `Bearer ${seen.credentials?.access_token}` },
        });
        read = await res.json();
      }
      return ran;
    };
    expect(await run(exec)).toBe(true);

    expect(calls.at(-1)?.args).toEqual([
      "/opt/ocra/main.js",
      "review",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--publish",
      "--no-repo-config",
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
    expect(calls.at(-1)?.args).not.toContain("--fixes");
    // The file is a layer above the account's settings: setting fixes there would hide them.
    expect(seen.ocra).not.toHaveProperty("fixes");
    expect(read).toMatchObject({ settings: { fixes: true } });
  });

  it("leaves the runtime an account saved to its settings, which the file would override", async () => {
    const { auth } = await s.signIn(1);
    const saved = await s.call("/api/preferences", {
      method: "PUT",
      headers: auth,
      json: { runtime: "opencode" },
    });
    expect(saved.status).toBe(200);
    const seen: { ocra?: unknown } = {};
    const { exec } = fakeExec(0, seen);
    expect(await run(exec)).toBe(true);
    expect(seen.ocra).not.toHaveProperty("runtime");
  });

  it("retries a failed review later, then gives it up", async () => {
    const { exec } = fakeExec(2, {});
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    let now = new Date();
    for (const attempt of [1, 2, 3]) {
      expect(
        await runNextReview({
          db: s.host.db,
          platforms,
          bots,
          publicUrl: ORIGIN,
          dailyCalls: 1000,
          exec,
          cli: "x",
          now: () => now,
        }),
      ).toBe(true);
      const [job] = await scoped(s.host.db, accountId).autoReview.latestJobs();
      expect(job).toMatchObject({ attempts: attempt, error: "review_failed" });
      expect(job?.state).toBe(attempt < 3 ? "queued" : "failed");
      now = later(60 * attempt);
    }
  });

  it("gives up at once without a bot for the platform, running nothing", async () => {
    const { exec, calls } = fakeExec(0, {});
    const none: BotTokens = { forRepo: async () => null };
    await runNextReview({
      db: s.host.db,
      platforms,
      bots: none,
      publicUrl: ORIGIN,
      dailyCalls: 1000,
      exec,
      cli: "x",
    });
    expect(calls).toEqual([]);
    const [job] = await scoped(s.host.db, accountId).autoReview.latestJobs();
    expect(job).toMatchObject({ state: "failed", error: "no_bot" });
  });
  it("gives the review the repository's enabled plain-language checks, by their current ids", async () => {
    const checks = scoped(s.host.db, accountId).mergeChecks;
    const on = await checks.add(
      repoId,
      { kind: "instruction", mode: "block", settings: { text: "No new globals" } },
      20,
    );
    await checks.add(repoId, { kind: "instruction", mode: "off", settings: { text: "Off" } }, 20);
    await checks.add(
      repoId,
      { kind: "title", mode: "block", settings: { prefixes: ["feat"] } },
      20,
    );
    const configs: unknown[] = [];
    const exec: Exec = async (command, args) => {
      if (command === "git") {
        await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
        return { code: 0 };
      }
      configs.push(JSON.parse(await readFile(args.at(-1) ?? "", "utf8")));
      return { code: 0 };
    };
    expect(await run(exec)).toBe(true);
    expect(configs).toEqual([
      {
        runtime: "direct",
        github: { botLogin: "ocra-review[bot]" },
        mergeChecks: [
          {
            id: await instructionCheckId(on ?? "", "No new globals"),
            instruction: "No new globals",
          },
        ],
      },
    ]);
  });

  it("runs the repository's review profile: quiet in the configuration, thorough as --ultra", async () => {
    const data = scoped(s.host.db, accountId);
    const runs: { args: readonly string[]; config: unknown }[] = [];
    const exec: Exec = async (command, args) => {
      if (command === "git") {
        await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
        return { code: 0 };
      }
      runs.push({ args, config: JSON.parse(await readFile(args.at(-1) ?? "", "utf8")) });
      return { code: 0 };
    };
    await data.update("reviewRepos", repoId, { reviewProfile: "quiet" });
    expect(await run(exec)).toBe(true);
    await data.update("reviewRepos", repoId, { reviewProfile: "thorough" });
    await data.autoReview.queue(repoId, 8, C1, new Date());
    expect(await run(exec)).toBe(true);

    const [quiet, thorough] = runs;
    expect(quiet?.config).toEqual({
      runtime: "direct",
      reviewers: {
        performance: { enabled: false },
        docs: { enabled: false },
        "agents-md": { enabled: false },
      },
      showPreExisting: false,
      github: { botLogin: "ocra-review[bot]" },
    });
    expect(quiet?.args).not.toContain("--ultra");
    expect(thorough?.config).toEqual({
      runtime: "direct",
      github: { botLogin: "ocra-review[bot]" },
    });
    expect(thorough?.args.slice(-4)).toEqual([
      "--no-repo-config",
      "--ultra",
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
  });

  it("answers an @ocra comment with `ocra reply` on it, after the review", async () => {
    await scoped(s.host.db, accountId).replies.queue(repoId, 7, "502", true);
    await scoped(s.host.db, accountId).mergeChecks.add(
      repoId,
      { kind: "instruction", mode: "block", settings: { text: "No new globals" } },
      20,
    );
    const seen: { ocra?: unknown } = {};
    const { exec, calls } = fakeExec(0, seen);
    const runner = {
      db: s.host.db,
      platforms,
      bots,
      publicUrl: ORIGIN,
      dailyCalls: 1000,
      exec,
      cli: "/c.js",
    };
    expect(await runNextReply(runner)).toBe(true);
    expect(calls.at(-1)?.args).toEqual([
      "/c.js",
      "reply",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--comment",
      "502",
      "--inline",
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
    expect(calls.at(-1)?.env).toMatchObject({ GITHUB_TOKEN: "ghs_bot" });
    // Plain-language checks are a review's, not an answer's.
    expect(seen.ocra).toEqual({ runtime: "direct", github: { botLogin: "ocra-review[bot]" } });
    expect(await runNextReply(runner)).toBe(false);
    const [reply] = await scoped(s.host.db, accountId).list("replyJobs");
    expect(reply).toMatchObject({ state: "done", attempts: 1 });
  });

  it("retries an answer the CLI failed", async () => {
    await scoped(s.host.db, accountId).replies.queue(repoId, 7, "503", false);
    const { exec } = fakeExec(3, {});
    await runNextReply({
      db: s.host.db,
      platforms,
      bots,
      publicUrl: ORIGIN,
      dailyCalls: 1000,
      exec,
      cli: "x",
    });
    const [reply] = await scoped(s.host.db, accountId).list("replyJobs");
    expect(reply).toMatchObject({ state: "queued", error: "review_failed", attempts: 1 });
  });

  it("writes tests with `ocra generate` as a bot that may push, once per head", async () => {
    const generations = scoped(s.host.db, accountId).generations;
    expect(await generations.queue(repoId, 7, "a".repeat(40), "tests")).toBe(true);
    expect(await generations.queue(repoId, 7, "a".repeat(40), "tests")).toBe(false);
    const { exec, calls } = fakeExec(0, {});
    const asked: (string | undefined)[] = [];
    const committer: BotTokens = {
      forRepo: async (_p, _n, access) => {
        asked.push(access);
        return { token: "ghs_bot", login: "ocra-review[bot]" };
      },
    };
    const runner = {
      db: s.host.db,
      platforms,
      bots: committer,
      publicUrl: ORIGIN,
      dailyCalls: 1000,
      exec,
      cli: "/c.js",
    };
    expect(await runNextGeneration(runner)).toBe(true);
    expect(asked).toEqual(["commit"]);
    expect(calls.at(-1)?.args).toEqual([
      "/c.js",
      "generate",
      "tests",
      "--pr",
      "7",
      "--repo",
      "Octo/API",
      "--config",
      expect.stringMatching(/ocra\.json$/),
    ]);
    expect(await runNextGeneration(runner)).toBe(false);
    const [job] = await generations.forPull(repoId, 7);
    expect(job).toMatchObject({ state: "done", attempts: 1 });
  });

  it("does not retry edits the CLI could not commit", async () => {
    const generations = scoped(s.host.db, accountId).generations;
    await generations.queue(repoId, 7, "b".repeat(40), "docstrings");
    const { exec } = fakeExec(3, {});
    await runNextGeneration({
      db: s.host.db,
      platforms,
      bots,
      publicUrl: ORIGIN,
      dailyCalls: 1000,
      exec,
      cli: "x",
    });
    const [job] = await generations.forPull(repoId, 7);
    expect(job).toMatchObject({ state: "failed", error: "not_committed", attempts: 1 });
  });
});
