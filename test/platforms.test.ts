import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto.js";
import * as schema from "../src/db/schema.js";
import { repoHashOf, repoIdentity } from "../src/platforms/platform.js";
import { resetDb, signIn } from "./helpers.js";
import {
  connectGitlab as connect,
  githubFake,
  SESSION,
  signInWithGithub,
} from "./platform-fakes.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const db = drizzle(env.DB);

type Listed = {
  sharing: boolean;
  platforms: {
    platform: string;
    host: string;
    linked: boolean;
    repositories: { fullName: string; repoHash: string | null }[];
  }[];
};
const githubOf = (l: Listed) => l.platforms.find((p) => p.platform === "github");

describe("a repository's identity", () => {
  it("is the CLI's for a clone: https, no port, no .git, case-folded, under the relative root", () => {
    const at = (url: string) => ({ url });
    expect(repoIdentity(at("https://github.com"), "Org/Repo")).toBe("https://github.com/org/repo");
    expect(repoIdentity(at("https://github.com"), "org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(repoIdentity(at("https://gitlab.example.com:8443"), "group/sub/project")).toBe(
      "https://gitlab.example.com/group/sub/project",
    );
    expect(repoIdentity(at("http://example.com/GitLab"), "Group/Project")).toBe(
      "https://example.com/gitlab/group/project",
    );
  });
});

describe("the GitHub link", () => {
  it("keeps the sign-in token encrypted and lists the App's repositories with the CLI's hash", async () => {
    const fake = githubFake();
    const a = await signInWithGithub();
    const [link] = await db.select().from(schema.platformLinks);
    expect(link?.ciphertext).toBeDefined();
    expect(JSON.stringify(link)).not.toContain("ghu_first");
    expect(JSON.stringify(link)).not.toContain("ghr_first");

    const before = (await (await a.send("/api/platforms/repos")).json()) as Listed;
    expect(before.sharing).toBe(false);
    expect(githubOf(before)).toMatchObject({
      host: "github.com",
      linked: true,
      installUrl: "https://github.com/apps/ocra-cloud/installations/new",
    });
    expect(githubOf(before)?.repositories.map((r) => [r.fullName, r.repoHash])).toEqual([
      ["Octo/API", null],
      ["octo/web", null],
    ]);
    const asUser = fake.mock.calls.find(([i]) =>
      new Request(i).url.includes("/user/installations"),
    );
    expect(new Request(asUser?.[0] as RequestInfo, asUser?.[1]).headers.get("authorization")).toBe(
      "Bearer ghu_first",
    );

    await a.send("/api/account/sharing", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    const salt = ((await (await a.send("/api/account/salt")).json()) as { salt: string }).salt;
    const after = (await (await a.send("/api/platforms/repos")).json()) as Listed;
    const hash = githubOf(after)?.repositories[0]?.repoHash;
    // What the CLI uploads for a clone of github.com/Octo/API, over any URL.
    expect(hash).toBe(await repoHashOf(salt, { url: "https://github.com" }, "octo/api"));

    const synced = await a.send("/api/platforms/sync-names", { method: "POST" });
    expect(await synced.json()).toEqual({ named: 2, sharing: true });
    const repos = (await (await a.send("/api/repositories")).json()) as {
      repositories: { name: string | null }[];
    };
    expect(repos.repositories.map((r) => r.name).sort()).toEqual(["Octo/API", "octo/web"]);

    const exported = await (await a.send("/api/export")).text();
    expect(exported).not.toContain("ghu_first");
    expect(exported).not.toContain(link?.ciphertext ?? "-");
  });

  it("refreshes an expired token, and drops the link when GitHub refuses the refresh", async () => {
    githubFake({
      refresh: () =>
        Response.json({
          access_token: "ghu_second",
          refresh_token: "ghr_second",
          expires_in: 28_800,
        }),
    });
    const a = await signInWithGithub();
    await db.update(schema.platformLinks).set({ accessExpiresAt: new Date(0) });
    const linked = async () =>
      githubOf((await (await a.send("/api/platforms/repos")).json()) as Listed)?.linked;
    expect(await linked()).toBe(true);
    const [refreshed] = await db.select().from(schema.platformLinks);
    expect((refreshed?.accessExpiresAt?.getTime() ?? 0) > Date.now()).toBe(true);

    vi.restoreAllMocks();
    githubFake();
    await db.update(schema.platformLinks).set({ accessExpiresAt: new Date(0) });
    expect(await linked()).toBe(false);
    expect(await db.select().from(schema.platformLinks)).toEqual([]);
  });
});

describe("connecting GitLab", () => {
  it("keeps the user's token for the instance and lists their projects under the CLI's hash", async () => {
    githubFake();
    const a = await signInWithGithub();
    const back = await (await connect(a))("code=c&state=STATE");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/repositories");
    const links = await db.select().from(schema.platformLinks);
    expect(links.map((l) => [l.platform, l.host]).sort()).toEqual([
      ["github", "github.com"],
      ["gitlab", "gitlab.example.com:8443"],
    ]);
    expect(JSON.stringify(links)).not.toContain("glpat_first");
    // Who the link is of, by id and the login a mention names.
    const link = links.find((l) => l.platform === "gitlab");
    expect([link?.userId, link?.login]).toEqual(["77", "Lab.User"]);

    await a.send("/api/account/sharing", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    const salt = ((await (await a.send("/api/account/salt")).json()) as { salt: string }).salt;
    const listed = (await (await a.send("/api/platforms/repos")).json()) as Listed;
    const lab = listed.platforms.find((p) => p.platform === "gitlab");
    expect(lab?.repositories.map((r) => r.fullName)).toEqual(["Group/Sub/Project"]);
    // The CLI's identity for a clone of it: https, no port, case-folded.
    expect(lab?.repositories[0]?.repoHash).toBe(
      await sha256Hex(`${salt}:https://gitlab.example.com/group/sub/project`),
    );
  });

  it("finishes only for the account that started it, with its state", async () => {
    githubFake();
    const a = await signInWithGithub();
    const finish = await connect(a);
    expect((await finish("code=c&state=forged")).status).toBe(400);
    const other = await signIn(2, "other");
    const otherCookie = `${SESSION}=${other.token}`;
    expect((await finish("code=c&state=STATE", otherCookie)).status).toBe(400);
    expect(
      (await db.select().from(schema.platformLinks)).filter((l) => l.platform === "gitlab"),
    ).toEqual([]);
  });
});
