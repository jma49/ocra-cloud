import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathReader } from "../src/auto-review/paths.js";
import { recordGitlabRequests } from "../src/auto-review/requests.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellGitlabHook } from "../src/notify/pull-hooks.js";
import { runReminders } from "../src/notify/reminders.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import type { NotifyEvent } from "../src/shared/index.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// A GitLab merge request whose approval rules name a group reaches the
// group's members as a GitHub team's ask does: the rules are read when it
// opens, reopens or gains commits, the group's direct members are paged
// and kept a day, each member on the account is told once and reminded,
// a member's approval ends the ask, and a group no longer named is asked
// no more.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const LAB = "https://gitlab.test";
const ME = 42;
const AUTHOR = 7;
// The tell step records asks at the time it runs.
const now = new Date();
const later = (hours: number) => new Date(now.getTime() + hours * HOUR);

const out = (): Outbox => ({
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
});

type Group = { id: number; full_path: string; members: number[] };

/** GitLab with these approval rules' groups (null: the rules are refused); Slack takes every post. */
function platform(rules: () => { rule_type: string; groups: Group[] }[] | null) {
  const asked: string[] = [];
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (!req.url.startsWith(LAB)) {
      posted.push(((await req.json()) as { text: string }).text);
      return new Response("ok");
    }
    const url = new URL(req.url);
    asked.push(`${url.pathname}${url.search}`);
    const listed = rules();
    if (url.pathname.endsWith("/approval_rules")) {
      if (!listed) return new Response(null, { status: 403 });
      return Response.json(
        listed.map((r) => ({
          rule_type: r.rule_type,
          groups: r.groups.map((g) => ({ id: g.id, full_path: g.full_path })),
        })),
      );
    }
    const group = /^\/api\/v4\/groups\/(\d+)\/members$/.exec(url.pathname);
    const found = listed?.flatMap((r) => r.groups).find((g) => g.id === Number(group?.[1]));
    if (!found) return new Response(null, { status: 404 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const members = found.members.slice((page - 1) * 100, page * 100);
    return Response.json(members.map((id) => ({ id, username: `u${id}`, state: "active" })));
  });
  return { asked, posted };
}

async function setUp(events: NotifyEvent[]) {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events, reminderHours: 4 },
  });
  await data.insert("platformLinks", {
    platform: "gitlab",
    host: "gitlab.test",
    wrappedKey: "w",
    ciphertext: "c",
    userId: String(ME),
    login: "lab-mona",
  });
  const repoId = await data.insert("reviewRepos", {
    platform: "gitlab",
    host: "gitlab.test",
    platformRepoId: "9",
    fullName: "group/api",
  });
  const repo = await data.get("reviewRepos", repoId);
  if (!repo) throw new Error("not enrolled");
  await data.pullFlows.record({
    reviewRepoId: repo.id,
    number: 3,
    title: "MR 3",
    author: "hubot",
    authorId: String(AUTHOR),
    draft: false,
    size: 3,
    openedAt: now,
    seenAt: now,
  });
  const reader: PathReader = {
    db,
    bots: { forRepo: async () => ({ token: "bot-token" }) },
    platforms: [{ kind: "gitlab", host: "gitlab.test", url: LAB } as CodePlatform],
    env: { MASTER_KEY: "", MASTER_KEY_PREVIOUS: "" } as PathReader["env"],
  };
  const tell = (body: unknown) => tellGitlabHook(db, out(), repo, body, reader);
  return { data, repo, tell };
}

const hook = (action: string, extra: Record<string, unknown> = {}, changes?: object) => ({
  object_kind: "merge_request",
  user: { id: AUTHOR, username: "hubot" },
  object_attributes: { iid: 3, action, title: "MR 3", author_id: AUTHOR, ...extra },
  project: { id: 9 },
  ...(changes ? { changes } : {}),
});

const backend = (members: number[]): Group => ({ id: 55, full_path: "acme/backend", members });

describe("a GitLab approval rule naming a group", () => {
  it("tells each member on the account once, whichever group, and not the author", async () => {
    const { tell } = await setUp(["review_requested"]);
    const groups = [backend([ME, AUTHOR]), { id: 56, full_path: "acme/web", members: [ME] }];
    const { posted } = platform(() => [{ rule_type: "regular", groups }]);
    expect(await tell(hook("open"))).toBe(1);
    await tell(hook("update", { oldrev: "a".repeat(40) }));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Approval was asked of acme/backend, a group you are on");
  });

  it("tells a member once when asked as a reviewer and through the group, and not again once they approved", async () => {
    const { repo, tell } = await setUp(["review_requested"]);
    const { posted } = platform(() => [{ rule_type: "regular", groups: [backend([ME])] }]);
    const me = { id: ME, username: "lab-mona" };
    await tell(
      hook(
        "open",
        { updated_at: now.toISOString() },
        { reviewers: { previous: [], current: [me] } },
      ),
    );
    expect(posted).toHaveLength(1);
    await recordGitlabRequests(db, repo, { ...hook("approved"), user: me }, later(1));
    await tell(hook("update", { oldrev: "d".repeat(40) }));
    expect(posted).toHaveLength(1);
  });

  it("reads the rules only when the merge request opens, reopens or gains commits", async () => {
    const { tell } = await setUp([]);
    const { asked } = platform(() => [{ rule_type: "code_owner", groups: [backend([ME])] }]);
    await tell(hook("update"));
    await tell(hook("approved"));
    expect(asked).toEqual([]);
    await tell(hook("open"));
    expect(asked).toEqual([
      "/api/v4/projects/group%2Fapi/merge_requests/3/approval_rules?per_page=100",
      "/api/v4/groups/55/members?per_page=100&page=1",
    ]);
  });

  it("pages a group's members and keeps them a day", async () => {
    const { data, tell } = await setUp([]);
    const many = Array.from({ length: 250 }, (_, i) => i + 1000);
    const { asked } = platform(() => [{ rule_type: "regular", groups: [backend([...many, ME])] }]);
    await tell(hook("open"));
    await tell(hook("reopen"));
    expect(asked.filter((u) => u.includes("/members"))).toHaveLength(3);
    const kept = await data.reviewTeams.find({
      platform: "gitlab",
      host: "gitlab.test",
      reviewerId: "team:55",
    });
    expect(kept).toMatchObject({ name: "acme/backend" });
    expect(kept?.members).toContain(`,${ME},`);
    await db.update(schema.reviewTeams).set({ fetchedAt: new Date(Date.now() - 25 * HOUR) });
    await tell(hook("reopen"));
    expect(asked.filter((u) => u.includes("/members"))).toHaveLength(6);
  });

  it("leaves report and any-approver rules out", async () => {
    const { data, tell } = await setUp([]);
    platform(() => [{ rule_type: "report_approver", groups: [backend([ME])] }]);
    await tell(hook("open"));
    expect(await data.find("reviewRequests", {}, 5)).toEqual([]);
  });

  it("reminds a member through the group, and stops once a member approved", async () => {
    const { repo, tell } = await setUp(["review_waiting"]);
    platform(() => [{ rule_type: "regular", groups: [backend([ME, 8])] }]);
    await tell(hook("open"));
    const { posted } = platform(() => null);
    await runReminders(db, out(), "github.com", later(5));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("MR 3 · asked of acme/backend");

    await recordGitlabRequests(
      db,
      repo,
      { ...hook("approved"), user: { id: 8, username: "u8" } },
      later(6),
    );
    await runReminders(db, out(), "github.com", later(12));
    expect(posted).toHaveLength(1);
  });

  it("asks the group no more once the rules stop naming it, and a refusal changes nothing", async () => {
    const { data, tell } = await setUp([]);
    let groups: Group[] | null = [backend([ME])];
    platform(() => (groups ? [{ rule_type: "regular", groups }] : null));
    await tell(hook("open"));
    groups = null;
    await tell(hook("update", { oldrev: "b".repeat(40) }));
    const asks = async () =>
      (await data.find("reviewRequests", {}, 5)).map((r) => [r.reviewerId, r.doneAt !== null]);
    expect(await asks()).toEqual([["team:55", false]]);
    groups = [];
    await tell(hook("update", { oldrev: "c".repeat(40) }));
    expect(await asks()).toEqual([["team:55", true]]);
  });
});
