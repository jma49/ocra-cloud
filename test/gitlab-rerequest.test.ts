import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordGitlabRequests } from "../src/auto-review/requests.js";
import { scoped } from "../src/db/scoped.js";
import { gitlabFields } from "../src/inbound/fields.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { gitlabPullEvents, tellGitlabHook } from "../src/notify/pull-hooks.js";
import { HOUR } from "../src/time.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// A reviewer GitLab asks again ("re-request review", GitLab 18.6 and
// later: the merge request hook's reviewers carry their state and
// re_requested) hears of it at once, as GitHub's review_requested tells
// them: once per round of review, which their answer ended, however often
// the hook is delivered, and the ask waits again from then.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const ME = 42;
const AUTHOR = 7;
// The asks of reviewers added are recorded at the time the hook is read.
const ASKED = new Date().toISOString();
const later = (hours: number) => new Date(Date.parse(ASKED) + hours * HOUR).toISOString();
const AGAIN = later(1);

const out = (): Outbox => ({
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: "https://console.test",
});

function slack() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    posted.push(((await new Request(input, init).json()) as { text: string }).text);
    return new Response("ok");
  });
  return posted;
}

async function setUp() {
  const me = await signIn(ME, "mona");
  const data = scoped(db, me.account.id);
  await call("/api/notifications/channels", {
    method: "POST",
    auth: me.auth,
    json: {
      kind: "slack",
      url: SLACK,
      name: "team",
      when: "blocking",
      events: ["review_requested"],
    },
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
  // As the webhook does: the asks are recorded, then the account is told.
  const deliver = async (body: unknown) => {
    await recordGitlabRequests(db, repo, body);
    return tellGitlabHook(db, out(), repo, body);
  };
  return { data, repo, deliver };
}

const reviewer = (state: string, reRequested = false) => ({
  id: ME,
  username: "lab-mona",
  state,
  re_requested: reRequested,
});

const hook = (updatedAt: string, changes: object) => ({
  object_kind: "merge_request",
  user: { id: AUTHOR, username: "hubot" },
  object_attributes: {
    iid: 3,
    action: "update",
    state: "opened",
    title: "MR 3",
    author_id: AUTHOR,
    updated_at: updatedAt,
  },
  project: { id: 9 },
  changes,
});

const added = hook(ASKED, { reviewers: { previous: [], current: [reviewer("unreviewed")] } });
const reasked = (was: string, at = AGAIN) =>
  hook(at, {
    reviewers: { previous: [reviewer(was)], current: [reviewer("unreviewed", true)] },
  });

describe("a GitLab reviewer asked again", () => {
  it("is a review_requested event of the reviewer, and the hook's stored fields keep it", () => {
    const events = gitlabPullEvents(reasked("reviewed"), "r");
    expect(events.map((e) => [e.kind, e.concerns, e.what])).toEqual([
      ["review_requested", String(ME), "hubot asked for your review again"],
    ]);
    expect(gitlabPullEvents(gitlabFields(reasked("reviewed")), "r")).toHaveLength(1);
  });

  it("is told at once after they reviewed, once however often the hook arrives", async () => {
    const posted = slack();
    const { deliver } = await setUp();
    expect(await deliver(added)).toBe(1);
    expect(await deliver(reasked("reviewed"))).toBe(1);
    expect(await deliver(reasked("reviewed"))).toBe(0);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("hubot asked for your review again");
  });

  it("is told again after requesting changes and after approving, each its own round", async () => {
    const posted = slack();
    const { deliver } = await setUp();
    await deliver(added);
    await deliver(reasked("requested_changes"));
    await deliver(reasked("approved", later(2)));
    expect(posted).toHaveLength(3);
  });

  it("is not told twice in one round: asked again before they answered", async () => {
    const posted = slack();
    const { deliver } = await setUp();
    await deliver(added);
    expect(await deliver(reasked("unreviewed"))).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it("waits again from GitLab's time for the ask, so the reminder starts over", async () => {
    slack();
    const { data, deliver } = await setUp();
    await deliver(added);
    await deliver(reasked("reviewed"));
    await deliver(reasked("reviewed"));
    const [row] = await data.find("reviewRequests", { reviewerId: String(ME) }, 5);
    expect(row?.requestedAt).toEqual(new Date(AGAIN));
    expect(row?.doneAt).toEqual(new Date(Date.parse(AGAIN) - 1));
  });
});
