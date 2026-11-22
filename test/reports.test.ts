import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { runDigests } from "../src/notify/digest.js";
import type { Outbox } from "../src/notify/notify.js";
import { lastSlot, nextSlot, runReports, span } from "../src/notify/report.js";
import type { ReportScheduleView } from "../src/shared/index.js";
import { DAY, HOUR } from "../src/time.js";
import { finding, upload } from "./finding-uploads.js";
import { call, db, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

// The weekly report and the merges the digest names: a week's numbers sent
// once per slot to the channels that take it, nothing for a quiet week,
// and finding titles only when the account shares findings.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: ORIGIN,
};

function slack() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push(String(((await req.json()) as { text: string }).text));
    return new Response("ok");
  });
  return posted;
}

describe("a report slot", () => {
  it("is the latest UTC weekday and hour at or before now, and the next a week on", () => {
    const now = new Date("2026-11-25T08:30:00Z"); // a Wednesday
    const monday9 = { weekday: 1, hour: 9 };
    expect(lastSlot(now, monday9).toISOString()).toBe("2026-11-23T09:00:00.000Z");
    expect(nextSlot(now, monday9).toISOString()).toBe("2026-11-30T09:00:00.000Z");
    expect(lastSlot(now, { weekday: 3, hour: 8 }).toISOString()).toBe("2026-11-25T08:00:00.000Z");
    expect(lastSlot(now, { weekday: 3, hour: 9 }).toISOString()).toBe("2026-11-18T09:00:00.000Z");
  });

  it("names a duration in days, hours or minutes", () => {
    expect(span(2 * DAY + 3 * HOUR)).toBe("2d 3h");
    expect(span(5 * HOUR + 60_000 * 7)).toBe("5h 7m");
    expect(span(59_000)).toBe("0m");
  });
});

/** An account with a weekly Slack channel, its slot an hour from now; when to run it. */
async function weeklyAccount(share: boolean) {
  const web = await signIn(1, "octo");
  const cli = await signInCli(1, "octo");
  if (share) {
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json: { enabled: true },
    });
  }
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: web.auth,
    json: { kind: "slack", name: "team", when: "blocking", url: SLACK, weekly: true },
  });
  expect(((await added.json()) as { channel: { weekly: boolean } }).channel.weekly).toBe(true);
  const slot = new Date(Math.ceil((Date.now() + 1) / HOUR) * HOUR);
  const put = await call("/api/notifications/report", {
    method: "PUT",
    auth: web.auth,
    json: { weekday: slot.getUTCDay(), hour: slot.getUTCHours() },
  });
  expect(((await put.json()) as ReportScheduleView).next).toBe(slot.toISOString());
  return { web, cli, at: new Date(slot.getTime() + 10 * 60_000) };
}

async function mergedPull(accountId: string, number: number, toMergeMs: number) {
  const data = scoped(db, accountId);
  const repoId =
    (await data.findOne("reviewRepos", { fullName: "octo/api" }))?.id ??
    (await data.insert("reviewRepos", {
      platform: "github",
      host: "github.com",
      platformRepoId: "11",
      fullName: "octo/api",
    }));
  const closedAt = new Date(Date.now() - 1000);
  await data.closedPulls.record({
    reviewRepoId: repoId,
    number,
    title: `Pull <@here> ${number}`,
    merged: true,
    openedAt: new Date(closedAt.getTime() - toMergeMs),
    closedAt,
  });
}

describe("the weekly report", () => {
  it("goes once per slot with the week's reviews, outcomes, merges and repositories", async () => {
    const posted = slack();
    const { cli, web, at } = await weeklyAccount(true);
    const pullRequest = {
      repository: "https://github.com/octo/api",
      number: 7,
      headSha: "a".repeat(40),
    };
    await call("/api/reviews", {
      method: "POST",
      auth: cli.auth,
      json: {
        ...upload("run-1", [finding({ title: "SQL built from input" })]),
        pullRequest,
        outcomes: { fixed: 2, dismissed: 1 },
      },
    });
    for (const [n, ms] of [
      [1, DAY],
      [2, 2 * DAY],
      [3, 3 * DAY],
    ] as const) {
      await mergedPull(web.account.id, n, ms);
    }
    // Another account's quiet week sends nothing.
    const other = await signIn(2, "hubot");
    await call("/api/notifications/channels", {
      method: "POST",
      auth: other.auth,
      json: { kind: "slack", name: "x", when: "every", url: SLACK, weekly: true },
    });
    posted.length = 0;

    // Not due before its slot, then once however many runs race for it.
    await runReports(db, out, new Date(at.getTime() - HOUR));
    expect(posted).toEqual([]);
    await Promise.all([runReports(db, out, at), runReports(db, out, at)]);
    await runReports(db, out, new Date(at.getTime() + HOUR));
    expect(posted).toHaveLength(1);
    const text = posted[0] ?? "";
    expect(text).toContain("1 review of 1 pull request");
    expect(text).toContain("1 critical · 0 warning · 0 suggestion");
    expect(text).toContain("2 fixed · 1 dismissed · 1 still open");
    expect(text).toContain("Merged: 3 pull requests · median time to merge 2d 0h");
    expect(text).toContain("• octo/api#3 Pull here 3");
    expect(text).toContain("Most reviewed: octo/api (1)");
    expect(text).toContain("critical: SQL built from input");
    expect(text).toContain(`<${ORIGIN}/insights|Insights>`);
  });

  it("leaves finding titles out when the account does not share findings", async () => {
    const posted = slack();
    const { cli, at } = await weeklyAccount(false);
    await call("/api/reviews", { method: "POST", auth: cli.auth, json: upload("run-1", []) });
    posted.length = 0;
    await runReports(db, out, at);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("0 fixed · 0 dismissed\n");
    expect(posted[0]).not.toContain("still open");
    expect(posted[0]).toContain("Merged: 0 pull requests\n");
  });

  it("is set per channel and slot by the web session only, in range", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const got = (await (
      await call("/api/notifications/report", { auth: web.auth })
    ).json()) as ReportScheduleView;
    expect([got.weekday, got.hour]).toEqual([1, 9]);
    for (const json of [
      { weekday: 7, hour: 9 },
      { weekday: 1, hour: 24 },
      { weekday: 1.5, hour: 9 },
    ]) {
      const res = await call("/api/notifications/report", { method: "PUT", auth: web.auth, json });
      expect(res.status).toBe(400);
    }
    expect((await call("/api/notifications/report", { auth: cli.auth })).status).toBe(403);
  });
});

describe("the daily digest's merges", () => {
  it("names the pull requests merged the day before, even without reviews", async () => {
    const posted = slack();
    const web = await signIn(1, "octo");
    await call("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "slack", name: "team", when: "blocking", url: SLACK, digest: true },
    });
    await mergedPull(web.account.id, 7, HOUR);
    posted.length = 0;
    await runDigests(db, out, new Date(Date.now() + DAY));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("0 reviews");
    expect(posted[0]).toContain("Merged: 1 pull request\n• octo/api#7 Pull here 7");
  });
});
