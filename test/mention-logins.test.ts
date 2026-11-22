import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { tellGithubHook, tellGitlabNote } from "../src/notify/pull-hooks.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// A mention names the account's user by the login on record: kept current
// whenever a webhook shows that user act under a new one, and naming nobody
// while another platform user is on record with it, so a login given up
// and taken by someone else does not deliver their mentions here.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const ME = 42;
const OTHER = 7;

function chats() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(((await req.json()) as { text: string }).text);
    return new Response("ok");
  });
  return posted;
}

const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
};

async function setUp(login = "mona") {
  const me = await signIn(ME, login);
  const data = scoped(db, me.account.id);
  const repoId = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  const repo = (await data.get("reviewRepos", repoId)) as NonNullable<
    Awaited<ReturnType<typeof data.get<"reviewRepos">>>
  >;
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: { kind: "slack", url: SLACK, name: "team", when: "blocking", events: ["mentioned"] },
  });
  expect(added.ok).toBe(true);
  return { me, data, repo };
}

const user = (id: number, login: string) => ({ id, login, type: "User" });

const issueComment = (body: string, by: ReturnType<typeof user>, id: number) => ({
  action: "created",
  issue: { number: 5, title: "T", user: user(OTHER, "x"), pull_request: {} },
  comment: { id, body, user: by },
  sender: by,
  repository: { id: 11 },
});

describe("a GitHub mention", () => {
  it("follows the login the user was last seen acting under", async () => {
    const posted = chats();
    await setUp();
    const own = issueComment("renamed", user(ME, "mona-new"), 1);
    expect(await tellGithubHook(db, out, "issue_comment", own)).toBe(0);
    const old = issueComment("@mona hi", user(OTHER, "hubot"), 2);
    expect(await tellGithubHook(db, out, "issue_comment", old)).toBe(0);
    const now = issueComment("@mona-new hi", user(OTHER, "hubot"), 3);
    expect(await tellGithubHook(db, out, "issue_comment", now)).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it("names nobody while another GitHub user is on record with the login", async () => {
    chats();
    await setUp();
    await signIn(99, "Mona");
    const body = issueComment("@mona hi", user(OTHER, "hubot"), 2);
    expect(await tellGithubHook(db, out, "issue_comment", body)).toBe(0);
  });
});

describe("a GitLab mention", () => {
  const note = (text: string, by: { id: number; username: string }, id: number) => ({
    object_kind: "note",
    user: by,
    object_attributes: { id, note: text, noteable_type: "MergeRequest" },
    merge_request: { iid: 3, title: "T", author_id: OTHER },
    project: { id: 9 },
  });
  const link = (userId: number, login: string) => ({
    platform: "gitlab" as const,
    host: "gitlab.test",
    wrappedKey: "w",
    ciphertext: "c",
    userId: String(userId),
    login,
  });

  it("follows the username the user was last seen acting under", async () => {
    const posted = chats();
    const { data, repo } = await setUp();
    const gitlab = { ...repo, platform: "gitlab" as const, host: "gitlab.test" };
    await data.insert("platformLinks", link(ME, "lab-mona"));
    const hubot = { id: OTHER, username: "hubot" };
    expect(
      await tellGitlabNote(db, out, gitlab, note("hi", { id: ME, username: "lab-new" }, 1)),
    ).toBe(0);
    expect(await tellGitlabNote(db, out, gitlab, note("@lab-mona hi", hubot, 2))).toBe(0);
    expect(await tellGitlabNote(db, out, gitlab, note("@lab-new hi", hubot, 3))).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it("names nobody while another account's link on the host has the login", async () => {
    chats();
    const { data, repo } = await setUp();
    const gitlab = { ...repo, platform: "gitlab" as const, host: "gitlab.test" };
    await data.insert("platformLinks", link(ME, "lab-mona"));
    const other = await signIn(99, "someone");
    await scoped(db, other.account.id).insert("platformLinks", link(77, "Lab-Mona"));
    const hubot = { id: OTHER, username: "hubot" };
    expect(await tellGitlabNote(db, out, gitlab, note("@lab-mona hi", hubot, 2))).toBe(0);
  });
});
