import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { appJwt, botTokens } from "../src/node/bot-tokens.js";
import { type Exec, runNextReply, runNextReview } from "../src/node/review-runner.js";
import type { BotTokens } from "../src/platforms/bot.js";
import { github } from "../src/platforms/github.js";
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
    const bot = await botTokens({ githubAppId: "123", githubAppPrivateKey: PEM }).forRepo(
      "github",
      "Octo/API",
    );
    expect(bot).toEqual({ token: "ghs_bot", login: "ocra-review[bot]" });
    const minted = asked.find((a) => a.url.endsWith("/access_tokens"));
    expect(minted?.body).toEqual({
      repositories: ["API"],
      permissions: { contents: "read", pull_requests: "write", metadata: "read" },
    });
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
    expect(await botTokens({ githubAppId: "123" }).forRepo("github", "Octo/API")).toBeNull();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(null, { status: 404 }),
    );
    const bots = botTokens({ githubAppId: "123", githubAppPrivateKey: PEM });
    expect(await bots.forRepo("github", "Octo/API")).toBeNull();
    expect(await botTokens({ gitlabBotToken: "glpat-bot" }).forRepo("gitlab", "g/p")).toEqual({
      token: "glpat-bot",
    });
  });

  it("signs a JWT that lives under GitHub's ten minutes", () => {
    const body = JSON.parse(
      Buffer.from(appJwt("1", PEM, 1_000_000).split(".")[1] ?? "", "base64url").toString(),
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
  const platforms = [github({ id: "self-hosted-app", secret: "test-client-secret" })];

  beforeEach(async () => {
    s = await graphServer(dir, `runner-${n++}.db`, "off", undefined, { bots: {}, workers: 0 });
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
  const fakeExec = (cliCode: number, seen: { credentials?: unknown; config?: string }) => {
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
      seen.config = await readFile(join(options.cwd, ".git", "config"), "utf8");
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
      exec,
      cli: "/opt/ocra/main.js",
    });

  it("clones, runs the CLI on the pull request as the account and the bot, and leaves nothing", async () => {
    const seen: { credentials?: Record<string, unknown>; config?: string } = {};
    const { exec, calls } = fakeExec(1, seen);
    expect(await run(exec)).toBe(true);

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

    // The run's directory and its session are gone, the job done.
    expect(existsSync(clone?.args.at(-1) ?? "")).toBe(false);
    const sessions = await scoped(s.host.db, accountId).list("sessions");
    expect(sessions.filter((x) => x.label === "auto review")).toEqual([]);
    const [job] = await scoped(s.host.db, accountId).autoReview.latestJobs();
    expect(job).toMatchObject({ state: "done", attempts: 1 });
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
      exec,
      cli: "x",
    });
    expect(calls).toEqual([]);
    const [job] = await scoped(s.host.db, accountId).autoReview.latestJobs();
    expect(job).toMatchObject({ state: "failed", error: "no_bot" });
  });
  it("answers an @ocra comment with `ocra reply` on it, after the review", async () => {
    await scoped(s.host.db, accountId).replies.queue(repoId, 7, "502", true);
    const { exec, calls } = fakeExec(0, {});
    const runner = { db: s.host.db, platforms, bots, publicUrl: ORIGIN, exec, cli: "/c.js" };
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
    expect(await runNextReply(runner)).toBe(false);
    const [reply] = await scoped(s.host.db, accountId).list("replyJobs");
    expect(reply).toMatchObject({ state: "done", attempts: 1 });
  });

  it("retries an answer the CLI failed", async () => {
    await scoped(s.host.db, accountId).replies.queue(repoId, 7, "503", false);
    const { exec } = fakeExec(3, {});
    await runNextReply({ db: s.host.db, platforms, bots, publicUrl: ORIGIN, exec, cli: "x" });
    const [reply] = await scoped(s.host.db, accountId).list("replyJobs");
    expect(reply).toMatchObject({ state: "queued", error: "review_failed", attempts: 1 });
  });
});
