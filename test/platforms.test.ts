import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import { repoHashOf, repoIdentity } from "../src/platforms/platform.js";
import { call, ORIGIN, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SESSION = "__Host-ocra_session";
const STATE = "__Host-ocra_oauth_state";
const db = drizzle(env.DB);

function cookieValue(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const [k, v] = (line.split(";")[0] ?? "").split("=");
    if (k === name) return v;
  }
  return undefined;
}

type Fake = { refresh?: () => Response };

/** GitHub: sign-in, the user, one installation with two repositories, and refreshes. */
function githubFake(fake: Fake = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    if (url === "https://github.com/login/oauth/access_token") {
      const body = (await req.json()) as { grant_type?: string };
      if (body.grant_type === "refresh_token") {
        return fake.refresh?.() ?? Response.json({ error: "bad_refresh_token" });
      }
      return Response.json({
        access_token: "ghu_first",
        refresh_token: "ghr_first",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "octo" });
    if (url.startsWith("https://api.github.com/user/installations/7/repositories")) {
      return Response.json({
        repositories: [
          { id: 1, full_name: "Octo/API", private: true, html_url: "https://github.com/Octo/API" },
          { id: 2, full_name: "octo/web", private: false, html_url: "https://github.com/octo/web" },
        ],
      });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return Response.json({
        installations: [{ id: 7, account: { login: "octo", type: "Organization" } }],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function signInWithGithub() {
  const start = await call("/api/auth/github/login");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const res = await call(`/api/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${STATE}=${cookieValue(start, STATE)}` },
  });
  const cookie = `${SESSION}=${cookieValue(res, SESSION)}`;
  const send = (path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { cookie, origin: ORIGIN, ...init.headers } });
  return { send };
}

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
  it("is the CLI's: https, no port, no .git, case-folded", () => {
    // The engine's vectors (normaliseRemote in packages/cli/src/repository-id.test.ts).
    expect(repoIdentity("github.com", "Org/Repo")).toBe("https://github.com/org/repo");
    expect(repoIdentity("github.com", "org/repo.git")).toBe("https://github.com/org/repo");
    expect(repoIdentity("gitlab.example.com:8443", "group/sub/project")).toBe(
      "https://gitlab.example.com/group/sub/project",
    );
    expect(repoIdentity("gitlab.com", "Group/Sub/Project")).toBe(
      "https://gitlab.com/group/sub/project",
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
    expect(githubOf(before)).toMatchObject({ host: "github.com", linked: true });
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
    expect(hash).toBe(await repoHashOf(salt, "github.com", "octo/api"));

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
