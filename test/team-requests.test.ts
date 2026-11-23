import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordGithubRequest } from "../src/auto-review/requests.js";
import { teamMembers } from "../src/auto-review/teams.js";
import { CallBudget, item, withCalls } from "../src/calls.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellGithubHook } from "../src/notify/pull-hooks.js";
import { runReminders } from "../src/notify/reminders.js";
import type { BotTokens } from "../src/platforms/bot.js";
import { botTokens } from "../src/platforms/bot-tokens.js";
import type { NotifyEvent, PullItem } from "../src/shared/index.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// A review asked of a GitHub team reaches its members: who is on it is read
// with the App's Members permission and kept a day; the account's user on
// it is told once per pull request, reminded, and sees the team in the
// inbox; a member's review ends the ask; a refusal is no error.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const ME = 42;
const OTHER = 7;
const now = new Date(Date.UTC(2026, 10, 20, 12, 30));
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
};

function chats() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(((await req.json()) as { text: string }).text);
    return new Response("ok");
  });
  return posted;
}

/** The App, as a fake: the members of acme/core, or a refusal (null). */
function app(members: number[] | null) {
  const asked: string[] = [];
  const bots: BotTokens = {
    forRepo: async () => null,
    teamMembers: async (org, slug) => {
      asked.push(`${org}/${slug}`);
      return members?.map(String) ?? null;
    },
  };
  return { bots, asked };
}

async function setUp(events: NotifyEvent[]) {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  await data.insert("reviewRepos", {
    id: "repo",
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "acme/api",
  });
  await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events, reminderHours: 4 },
  });
  await data.pullFlows.record({
    reviewRepoId: "repo",
    number: 5,
    title: "Pull 5",
    author: "hubot",
    authorId: String(OTHER),
    draft: false,
    size: 3,
    openedAt: ago(30),
    seenAt: ago(1),
  });
  return { me, data };
}

const TEAM = { platform: "github" as const, host: "github.com", reviewerId: "team:300" };

const teamAsk = (at: Date, slug = "core", teamId = 300, action = "review_requested") => ({
  action,
  number: 5,
  pull_request: { title: "Pull 5", updated_at: at.toISOString() },
  requested_team: { id: teamId, slug, name: slug },
  sender: { id: OTHER, login: "hubot", type: "User" },
  repository: { id: 11, owner: { login: "acme" } },
});

/** The webhook's part and its tell step, as the App's delivery runs them. */
async function deliver(body: object, bots: BotTokens | undefined) {
  await recordGithubRequest(db, "github.com", "pull_request", body, now);
  return tellGithubHook(db, "github.com", out, "pull_request", body, bots);
}

describe("a review asked of a team", () => {
  it("tells each member on the account once per pull request, re-asked or through another team", async () => {
    await setUp(["review_requested"]);
    const { bots } = app([ME, OTHER]);
    const posted = chats();
    await deliver(teamAsk(ago(3)), bots);
    await deliver(teamAsk(ago(2)), bots);
    await deliver(teamAsk(ago(1), "web", 301), bots);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("hubot asked acme/core, a team you are on, for a review");
  });

  it("tells nobody who is not on the team", async () => {
    await setUp(["review_requested"]);
    const posted = chats();
    await deliver(teamAsk(ago(3)), app([OTHER]).bots);
    expect(posted).toEqual([]);
  });

  it("reads who is on it once a day at most", async () => {
    const { data } = await setUp([]);
    const { bots, asked } = app([ME]);
    await deliver(teamAsk(ago(3)), bots);
    await deliver(teamAsk(ago(2)), bots);
    expect(asked).toEqual(["acme/core"]);
    const kept = await data.reviewTeams.find({
      platform: "github",
      host: "github.com",
      reviewerId: "team:300",
    });
    expect(kept).toMatchObject({ name: "acme/core", members: `,${ME},` });
    await db.update(schema.reviewTeams).set({ fetchedAt: new Date(Date.now() - 25 * HOUR) });
    await deliver(teamAsk(ago(1)), bots);
    expect(asked).toEqual(["acme/core", "acme/core"]);
  });

  it("is no error when the App may not read members, and asks again only after a day", async () => {
    const { data } = await setUp(["review_requested"]);
    const { bots, asked } = app(null);
    const posted = chats();
    await expect(deliver(teamAsk(ago(3)), bots)).resolves.toBe(0);
    await deliver(teamAsk(ago(2)), bots);
    expect(asked).toHaveLength(1);
    expect(posted).toEqual([]);
    const kept = await data.find("reviewTeams", {}, 5);
    expect(kept.map((t) => t.members)).toEqual([null]);
    await expect(deliver(teamAsk(ago(1)), undefined)).resolves.toBe(0);
  });

  it("reminds a member, says through which team, and stops once a member reviewed", async () => {
    await setUp(["review_waiting"]);
    await deliver(teamAsk(ago(6)), app([ME, OTHER]).bots);
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Waiting for your review (1):");
    expect(posted[0]).toContain("Pull 5 · asked of acme/core · waiting 6h 0m");

    await recordGithubRequest(db, "github.com", "pull_request", teamAsk(ago(1)), now);
    await recordGithubRequest(db, "github.com", "pull_request_review", {
      action: "submitted",
      review: { user: { id: OTHER }, submitted_at: ago(0.5).toISOString() },
      pull_request: { number: 5 },
      repository: { id: 11 },
    });
    await runReminders(db, out, "github.com", new Date(now.getTime() + 8 * HOUR));
    expect(posted).toHaveLength(1);
  });

  it("is reminded once when asked of the user and of their team, as asked of the user", async () => {
    await setUp(["review_waiting"]);
    await deliver(teamAsk(ago(8)), app([ME]).bots);
    await recordGithubRequest(db, "github.com", "pull_request", {
      action: "review_requested",
      number: 5,
      pull_request: { updated_at: ago(6).toISOString() },
      requested_reviewer: { id: ME },
      repository: { id: 11 },
    });
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Waiting for your review (1):");
    expect(posted[0]).not.toContain("asked of acme/core");
  });

  it("ends when the team is asked no more", async () => {
    await setUp(["review_waiting"]);
    await deliver(teamAsk(ago(6)), app([ME]).bots);
    await recordGithubRequest(
      db,
      "github.com",
      "pull_request",
      teamAsk(ago(5), "core", 300, "review_request_removed"),
    );
    const posted = chats();
    await runReminders(db, out, "github.com", now);
    expect(posted).toEqual([]);
  });

  it("leaves the team out of who carries the review work", async () => {
    const { data } = await setUp([]);
    await deliver(teamAsk(ago(6)), app([ME]).bots);
    await recordGithubRequest(db, "github.com", "pull_request", {
      action: "review_requested",
      number: 5,
      pull_request: { updated_at: ago(6).toISOString() },
      requested_reviewer: { id: OTHER, login: "hubot" },
      repository: { id: 11 },
    });
    expect((await data.reviewLoad.openAsks(null, 10)).map((a) => a.login)).toEqual(["hubot"]);
    expect((await data.reviewLoad.asksSince(new Date(0), null, 10)).map((a) => a.login)).toEqual([
      "hubot",
    ]);
  });
});

describe("the inbox", () => {
  it("names the team a pull request asking the user's review came through", async () => {
    const node = (n: number) => ({
      id: `PR_${n}`,
      number: n,
      title: `Change ${n}`,
      url: `https://github.com/acme/api/pull/${n}`,
      isDraft: false,
      state: "OPEN",
      mergedAt: null,
      createdAt: "2026-11-20T10:00:00Z",
      updatedAt: "2026-11-21T10:00:00Z",
      additions: 1,
      deletions: 1,
      reviewDecision: "REVIEW_REQUIRED",
      author: { login: "hubot" },
      repository: { nameWithOwner: "acme/api" },
    });
    githubFake({
      extra: async (req) =>
        req.url === "https://api.github.com/graphql"
          ? Response.json({
              data: {
                review: { issueCount: 2, nodes: [node(5), node(6)] },
                authored: { issueCount: 0, nodes: [] },
                merged: { issueCount: 0, nodes: [] },
              },
            })
          : undefined,
    });
    const a = await signInWithGithub();
    const [account] = await db.select().from(schema.accounts);
    const data = scoped(db, account?.id ?? "");
    await data.insert("reviewRepos", {
      id: "repo",
      platform: "github",
      host: "github.com",
      platformRepoId: "11",
      fullName: "acme/api",
    });
    const { bots } = app([ME]);
    await recordGithubRequest(db, "github.com", "pull_request", teamAsk(new Date()));
    await tellGithubHook(db, "github.com", out, "pull_request", teamAsk(new Date()), bots);
    const listed = (await (await a.send("/api/platforms/pulls")).json()) as {
      platforms: { platform: string; pulls: PullItem[] }[];
    };
    const pulls = listed.platforms.find((p) => p.platform === "github")?.pulls ?? [];
    expect(pulls.map((p) => [p.number, p.requestedTeam ?? null])).toEqual([
      [5, "acme/core"],
      [6, null],
    ]);
  });
});

async function appKey() {
  const { privateKey } = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}

/** GitHub with acme/core of `size` members, ids 1 to size, 100 a page; the URLs it was asked. */
async function githubTeam(size: number | "refused") {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    urls.push(url.toString());
    if (url.pathname === "/orgs/acme/installation") return Response.json({ id: 9 });
    if (url.pathname === "/app/installations/9/access_tokens") return Response.json({ token: "t" });
    if (url.pathname === "/orgs/acme/teams/core/members") {
      if (size === "refused") return new Response(null, { status: 403 });
      const page = Number(url.searchParams.get("page") ?? "1");
      const ids = Array.from({ length: size }, (_, i) => i + 1).slice((page - 1) * 100, page * 100);
      return Response.json([
        ...ids.map((id) => ({ id })),
        ...(page === 1 ? [{ login: "no-id" }] : []),
      ]);
    }
    return new Response(null, { status: 404 });
  });
  const bots = botTokens({
    githubApi: "https://api.github.com",
    githubAppId: "1",
    githubAppPrivateKey: await appKey(),
  });
  const pages = () => urls.filter((u) => u.includes("/teams/core/members")).length;
  return { bots, urls, pages };
}

describe("the App's team read", () => {
  it("answers the members' ids, or null when GitHub refuses", async () => {
    const { bots, urls } = await githubTeam(2);
    expect(await bots.teamMembers?.("acme", "core")).toEqual(["1", "2"]);
    expect(urls).toContain(
      "https://api.github.com/orgs/acme/teams/core/members?per_page=100&page=1",
    );
    const refused = await githubTeam("refused");
    expect(await refused.bots.teamMembers?.("acme", "core")).toBeNull();
  });

  it("pages past 100 members until a page is short", async () => {
    const { bots, pages } = await githubTeam(250);
    const ids = await bots.teamMembers?.("acme", "core");
    expect(ids).toHaveLength(250);
    expect(ids?.at(-1)).toBe("250");
    expect(pages()).toBe(3);
  });

  it("reads ten pages at most, the first 1,000 members", async () => {
    const { bots, pages } = await githubTeam(1500);
    expect(await bots.teamMembers?.("acme", "core")).toHaveLength(1000);
    expect(pages()).toBe(10);
  });

  it("keeps every member read, up to 1,000", async () => {
    const { data } = await setUp([]);
    const { bots } = app(Array.from({ length: 1200 }, (_, i) => i + 1));
    await deliver(teamAsk(ago(1)), bots);
    const kept = await data.reviewTeams.find(TEAM);
    expect(kept?.members?.split(",").filter(Boolean)).toHaveLength(1000);
    expect(kept?.members).toContain(",1000,");
  });

  it("keeps nothing when the run's call budget cuts the pages short, so the read is tried again", async () => {
    const { data } = await setUp([]);
    const { bots } = await githubTeam(250);
    const read = bots.teamMembers;
    if (!read) throw new Error("no team read");
    // The installation, its token and one page: the second page is refused.
    const ran = await withCalls(new CallBudget(3), () =>
      item(() =>
        teamMembers(data, () => read("acme", "core"), { ...TEAM, name: "acme/core" }, now),
      ),
    );
    expect(ran.cut).toBe(true);
    expect(await data.reviewTeams.find(TEAM)).toBeNull();
  });
});
