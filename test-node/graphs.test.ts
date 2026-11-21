import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { upsertAccount } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { graphPolicy } from "../src/graph/policy.js";
import { bindingsFrom } from "../src/node/env.js";
import { openHost } from "../src/node/host.js";
import { gitlab } from "../src/platforms/gitlab.js";
import { saveToken } from "../src/platforms/links.js";
import { githubOf, gitlabCallback, gitlabClientOf } from "../src/platforms/registry.js";
import { startWebSession } from "../src/session.js";
import { C1, C2, C3, fakeBuilder, GITLAB, repoFake } from "./graph-fakes.js";

// Code graphs on the self-hosted server: a repository added by an account,
// built on pushes to its default branch, served to the CLI, pruned and
// purged, under each of the deployment's policies.

const ORIGIN = "http://ocra.test";
const SECRET = "hook-secret";
const VARS = {
  GITHUB_CLIENT_ID: "self-hosted-app",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  SESSION_SECRET: "test-session-secret",
  GITLAB_CLIENT_ID: "lab-app",
  GITLAB_CLIENT_SECRET: "lab-secret",
  GITLAB_URL: GITLAB,
};
const bindings = bindingsFrom(VARS);

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocra-graphs-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

async function serverWith(policy: "keep" | "opt-in" | "off", builder = fakeBuilder()) {
  const host = await openHost({
    databaseUrl: `file:${join(dir, `graphs-${n++}.db`)}`,
    bindings,
    migrations: resolve("migrations"),
    publicUrl: ORIGIN,
    graphs: { policy, builder: builder.builder, githubWebhookSecret: SECRET },
  });
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set("content-type", "application/json");
    return host.fetch(
      new Request(ORIGIN + path, {
        ...rest,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      }),
    );
  };
  const signIn = async (githubId: number) => {
    const account = await upsertAccount(host.db, githubId, `user-${githubId}`);
    const data = scoped(host.db, account.id);
    await saveToken(data, bindings, githubOf(bindings), { access_token: `ghu_${githubId}` });
    const lab = gitlabClientOf(bindings);
    if (lab) {
      await saveToken(data, bindings, gitlab(lab, gitlabCallback(ORIGIN)), {
        access_token: `glpat_${githubId}`,
      });
    }
    return {
      account,
      data,
      auth: { authorization: `Bearer ${await startWebSession(host.db, account.id)}` },
    };
  };
  const settled = () => vi.waitFor(() => expect(host.graphWorker?.busy() ?? false).toBe(false));
  const builds = (accountId: string) =>
    host.db
      .select()
      .from(schema.graphBuilds)
      .where(eq(schema.graphBuilds.accountId, accountId))
      .orderBy(schema.graphBuilds.createdAt)
      .all();
  return { host, call, signIn, settled, builds, builder };
}

type Server = Awaited<ReturnType<typeof serverWith>>;

const githubPush = (ref: string, after: string, fullName = "Octo/API") =>
  JSON.stringify({
    ref,
    after,
    repository: { id: 11, full_name: fullName, default_branch: "main" },
  });

async function pushToGithub(s: Server, body: string, signature?: string) {
  return s.call("/api/graphs/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": signature ?? `sha256=${await hmacHex(SECRET, body)}`,
    },
    body,
  });
}

const addRepo = (s: Server, auth: Record<string, string>, json: Record<string, unknown>) =>
  s.call("/api/graphs/repos", { method: "POST", headers: auth, json });

describe("CODE_GRAPH", () => {
  it("keeps graphs when unset, and takes only its three values", () => {
    expect(graphPolicy(undefined)).toBe("keep");
    expect(graphPolicy("opt-in")).toBe("opt-in");
    expect(graphPolicy("off")).toBe("off");
    expect(() => graphPolicy("always")).toThrow("CODE_GRAPH must be one of keep, opt-in, off");
  });
});

describe("a repository added for a code graph", () => {
  let s: Server;
  beforeEach(async () => {
    s = await serverWith("keep");
  });
  afterEach(async () => {
    await s.settled();
    s.host.close();
  });

  it("is checked on the platform as the account, and built at its default branch's head", async () => {
    const repo = repoFake({ [C1]: { "src/a.ts": "export const a = 1;", "README.md": "# api" } });
    const { account, auth } = await s.signIn(1);
    const res = await addRepo(s, auth, { platform: "github", fullName: "octo/api" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: { id: string }; webhook: unknown };
    expect(body).toMatchObject({
      repo: { fullName: "Octo/API", branch: "main", host: "github.com", latest: { commit: C1 } },
      webhook: { url: `${ORIGIN}/api/graphs/webhooks/github` },
    });
    expect(body.webhook).not.toHaveProperty("secret");
    await s.settled();
    const [build] = await s.builds(account.id);
    expect(build).toMatchObject({ commit: C1, state: "done", files: 2, parsed: 2 });
    expect(repo.reads).toHaveLength(2);
    // As the account: its own token.
    const auths = repo.fetch.mock.calls.map(([i, init]) =>
      new Request(i, init).headers.get("authorization"),
    );
    expect(new Set(auths)).toEqual(new Set(["Bearer ghu_1"]));

    const listed = await (await s.call("/api/graphs/repos", { headers: auth })).json();
    expect(listed).toMatchObject({
      repos: [{ id: body.repo.id, latest: { commit: C1, state: "done", files: 2 } }],
    });
  });

  it("is refused when the account does not reach it, or names a path outside a repository", async () => {
    repoFake({});
    const { auth } = await s.signIn(1);
    expect((await addRepo(s, auth, { platform: "github", fullName: "octo/secret" })).status).toBe(
      404,
    );
    for (const fullName of ["octo", "../octo/api", "octo/..", "octo/api?x=1"]) {
      expect((await addRepo(s, auth, { platform: "github", fullName })).status).toBe(400);
    }
  });

  it("is served to the CLI and the console, gzipped when asked, and only to its account", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    const { auth } = await s.signIn(1);
    const { repo } = (await (
      await addRepo(s, auth, { platform: "github", fullName: "octo/api" })
    ).json()) as {
      repo: { id: string };
    };
    await s.settled();
    const plain = await s.call(`/api/graphs/repos/${repo.id}/graph`, { headers: auth });
    expect(plain.headers.get("x-ocra-graph-commit")).toBe(C1);
    expect(await plain.json()).toMatchObject({ revision: C1 });
    const gz = await s.call(`/api/graphs/repos/${repo.id}/graph?commit=${C1}`, {
      headers: { ...auth, "accept-encoding": "gzip" },
    });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(
      (await s.call(`/api/graphs/repos/${repo.id}/graph?commit=${C2}`, { headers: auth })).status,
    ).toBe(404);
    expect(
      (await s.call(`/api/graphs/repos/${repo.id}/graph?commit=HEAD`, { headers: auth })).status,
    ).toBe(404);

    const other = await s.signIn(2);
    expect(
      (await s.call(`/api/graphs/repos/${repo.id}/graph`, { headers: other.auth })).status,
    ).toBe(404);
    const purge = await s.call(`/api/graphs/repos/${repo.id}/graphs`, {
      method: "DELETE",
      headers: other.auth,
    });
    expect(purge.status).toBe(404);
    expect(await (await s.call("/api/graphs/repos", { headers: other.auth })).json()).toEqual({
      repos: [],
    });
  });

  it("is purged of its graphs, and deleted with them", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    const { account, auth } = await s.signIn(1);
    const { repo } = (await (
      await addRepo(s, auth, { platform: "github", fullName: "octo/api" })
    ).json()) as {
      repo: { id: string };
    };
    await s.settled();
    const purged = await s.call(`/api/graphs/repos/${repo.id}/graphs`, {
      method: "DELETE",
      headers: auth,
    });
    expect(await purged.json()).toEqual({ removed: 1 });
    expect(await s.builds(account.id)).toEqual([]);
    expect((await s.call(`/api/graphs/repos/${repo.id}/graph`, { headers: auth })).status).toBe(
      404,
    );
    const removed = await s.call(`/api/graphs/repos/${repo.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(await removed.json()).toEqual({ removed: true });
  });

  it("is exported without its hook secret or its graph's bytes", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    const { auth } = await s.signIn(1);
    await addRepo(s, auth, { platform: "gitlab", fullName: "group/api" });
    await s.settled();
    const text = await (await s.call("/api/export", { headers: auth })).text();
    const exported = JSON.parse(text) as Record<string, Record<string, unknown>[]>;
    expect(exported.graphRepos?.[0]).toMatchObject({ fullName: "group/api" });
    expect(exported.graphRepos?.[0]).not.toHaveProperty("webhookSecretHash");
    expect(exported.graphBuilds?.[0]).not.toHaveProperty("content");
  });
});

describe("a push webhook", () => {
  let s: Server;
  beforeEach(async () => {
    s = await serverWith("keep");
  });
  afterEach(async () => {
    await s.settled();
    s.host.close();
  });

  async function added(githubId: number) {
    const user = await s.signIn(githubId);
    await addRepo(s, user.auth, { platform: "github", fullName: "octo/api" });
    await s.settled();
    return user;
  }

  it("from GitHub is taken only with the App's signature", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    const body = githubPush("refs/heads/main", C2);
    expect((await pushToGithub(s, body, "sha256=forged")).status).toBe(401);
    expect((await pushToGithub(s, body, `sha256=${await hmacHex("other", body)}`)).status).toBe(
      401,
    );
    expect(
      (await pushToGithub(s, body.replace(C2, C3), `sha256=${await hmacHex(SECRET, body)}`)).status,
    ).toBe(401);
  });

  it("builds the new commit for every account that added the repository, reading only changed blobs", async () => {
    const repo = repoFake({
      [C1]: { "a.ts": "a", "b.ts": "b" },
      [C2]: { "a.ts": "a", "b.ts": "b changed", "c.ts": "c" },
    });
    const one = await added(1);
    const two = await added(2);
    repo.reads.length = 0;
    const res = await pushToGithub(s, githubPush("refs/heads/main", C2));
    expect(await res.json()).toEqual({ queued: 2 });
    await s.settled();
    for (const user of [one, two]) {
      const latest = (await s.builds(user.account.id)).at(-1);
      expect(latest).toMatchObject({ commit: C2, state: "done", files: 3, parsed: 2, reused: 1 });
    }
    // Each account's build reads with its own token, only b.ts's and c.ts's new blobs.
    expect(repo.reads.sort()).toEqual(
      [
        repo.blobId("b changed"),
        repo.blobId("c"),
        repo.blobId("b changed"),
        repo.blobId("c"),
      ].sort(),
    );
    expect(s.builder.calls.at(-1)?.previous).toContain(C1);
  });

  it("ignores other branches, tags, deleted branches, other events and repositories no account added", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    await added(1);
    for (const body of [
      githubPush("refs/heads/feature", C2),
      githubPush("refs/tags/v1", C2),
      githubPush("refs/heads/main", "0".repeat(40)),
    ]) {
      expect(await (await pushToGithub(s, body)).json()).toEqual({ queued: 0 });
    }
    const ping = JSON.stringify({ zen: "hi", hook_id: 1 });
    const res = await s.call("/api/graphs/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${await hmacHex(SECRET, ping)}`,
      },
      body: ping,
    });
    expect(res.status).toBe(202);
    const elsewhere = JSON.stringify({
      ref: "refs/heads/main",
      after: C2,
      repository: { id: 99, full_name: "else/where", default_branch: "main" },
    });
    expect(await (await pushToGithub(s, elsewhere)).json()).toEqual({ queued: 0 });
  });

  it("takes a renamed repository's new name, and queues a commit once", async () => {
    repoFake({ [C1]: { "a.ts": "a" }, [C2]: { "a.ts": "a" } });
    const { account, auth } = await added(1);
    await pushToGithub(s, githubPush("refs/heads/main", C2, "Octo/Renamed"));
    expect(
      await (await pushToGithub(s, githubPush("refs/heads/main", C2, "Octo/Renamed"))).json(),
    ).toEqual({
      queued: 0,
    });
    const listed = (await (await s.call("/api/graphs/repos", { headers: auth })).json()) as {
      repos: { fullName: string }[];
    };
    expect(listed.repos[0]?.fullName).toBe("Octo/Renamed");
    await s.settled();
    expect((await s.builds(account.id)).map((b) => b.commit)).toEqual([C1, C2]);
  });

  it("from GitLab is taken only with the secret of an account that added the project", async () => {
    repoFake({ [C1]: { "a.ts": "a" } });
    const one = await s.signIn(1);
    const two = await s.signIn(2);
    const secretOf = async (auth: Record<string, string>) =>
      (
        (await (await addRepo(s, auth, { platform: "gitlab", fullName: "group/api" })).json()) as {
          webhook: { url: string; secret: string };
        }
      ).webhook;
    const hookOne = await secretOf(one.auth);
    await secretOf(two.auth);
    expect(hookOne.url).toBe(`${ORIGIN}/api/graphs/webhooks/gitlab`);
    await s.settled();
    const push = (token: string) =>
      s.call("/api/graphs/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Push Hook", "x-gitlab-token": token },
        json: {
          ref: "refs/heads/main",
          checkout_sha: C2,
          project: { id: 21, path_with_namespace: "group/api", default_branch: "main" },
        },
      });
    expect((await push("ocra_hook_wrong")).status).toBe(401);
    expect(await (await push(hookOne.secret)).json()).toEqual({ queued: 1 });
    await s.settled();
    expect((await s.builds(one.account.id)).map((b) => b.commit)).toEqual([C1, C2]);
    expect((await s.builds(two.account.id)).map((b) => b.commit)).toEqual([C1]);
  });
});

describe("the deployment's policy", () => {
  it("opt-in: a repository is kept only with the owner's consent, which is recorded", async () => {
    const s = await serverWith("opt-in");
    try {
      repoFake({ [C1]: { "a.ts": "a" } });
      const { auth, data } = await s.signIn(1);
      const refused = await addRepo(s, auth, { platform: "github", fullName: "octo/api" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ issues: [{ path: ["consent"] }] });
      const ok = await addRepo(s, auth, {
        platform: "github",
        fullName: "octo/api",
        consent: true,
      });
      expect(ok.status).toBe(200);
      const [repo] = await data.find("graphRepos", {});
      expect(repo?.consentedAt).toBeInstanceOf(Date);
      await s.settled();
    } finally {
      s.host.close();
    }
  });

  it("off: no graph routes, no builds", async () => {
    const s = await serverWith("off");
    try {
      const { auth } = await s.signIn(1);
      expect((await addRepo(s, auth, { platform: "github", fullName: "octo/api" })).status).toBe(
        404,
      );
      expect((await pushToGithub(s, githubPush("refs/heads/main", C2))).status).toBe(404);
      expect(s.host.graphWorker).toBeUndefined();
    } finally {
      s.host.close();
    }
  });
});
