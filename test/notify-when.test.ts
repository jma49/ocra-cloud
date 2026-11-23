import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { runDigests } from "../src/notify/digest.js";
import type { Outbox } from "../src/notify/notify.js";
import { runReports } from "../src/notify/report.js";
import type { NotifyWhen } from "../src/shared/index.js";
import { DAY, HOUR } from "../src/time.js";
import { upload } from "./finding-uploads.js";
import { call, db, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

// A channel's `when` decides which reviews it hears about, in a review's
// announcement and in the digest and weekly report that sum them up: a
// channel set to blocking reviews hears of none without a critical finding,
// nor of a review that reviewed nothing.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: ORIGIN,
};

const hook = (when: NotifyWhen) => `https://hooks.slack.com/services/T000/B000/${when}`;

/** Every chat call's channel, by the `when` its address is named after. */
function told() {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    posted.push(new Request(input, init).url.split("/").pop() ?? "");
    return new Response("ok");
  });
  return posted;
}

/** An account with one Slack channel per `when`, each taking the digest and weekly report. */
async function account() {
  const web = await signIn(1, "octo");
  const cli = await signInCli(1, "octo");
  const slot = new Date(Math.ceil((Date.now() + 1) / HOUR) * HOUR);
  await call("/api/notifications/report", {
    method: "PUT",
    auth: web.auth,
    json: { weekday: slot.getUTCDay(), hour: slot.getUTCHours() },
  });
  for (const when of ["blocking", "findings", "every"] as const) {
    const res = await call("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "slack", name: when, when, url: hook(when), digest: true, weekly: true },
    });
    expect(res.status).toBe(200);
  }
  const review = async (runId: string, over: Record<string, unknown>) => {
    const json = { ...upload(runId, []), ...over };
    const res = await call("/api/reviews", { method: "POST", auth: cli.auth, json });
    expect(res.status).toBe(200);
  };
  const merged = async () => {
    const data = scoped(db, web.account.id);
    const reviewRepoId = await data.insert("reviewRepos", {
      platform: "github",
      host: "github.com",
      platformRepoId: "11",
      fullName: "octo/api",
    });
    const closedAt = new Date(Date.now() - 1000);
    await data.closedPulls.record({
      reviewRepoId,
      number: 7,
      title: "Merged",
      merged: true,
      openedAt: new Date(closedAt.getTime() - HOUR),
      closedAt,
    });
  };
  return { review, merged, reportAt: new Date(slot.getTime() + 10 * 60_000) };
}

const counts = (critical: number, warning: number) => ({
  findings: { critical, warning, suggestion: 0 },
});
/** A review the daily limit or quota stopped before it read a file. */
const reviewedNothing = {
  ...counts(0, 0),
  complete: false,
  verdict: null,
  files: { reviewed: 0, notReviewed: 12 },
  tasks: { completed: 0, failed: 3 },
};

const cases: [string, Record<string, unknown>[], NotifyWhen[]][] = [
  ["clean reviews", [counts(0, 0), counts(0, 0)], ["every"]],
  ["a review that reviewed nothing", [reviewedNothing], ["every"]],
  ["reviews with warnings only", [counts(0, 2), counts(0, 0)], ["findings", "every"]],
  [
    "a review with a critical finding",
    [counts(0, 0), counts(1, 0)],
    ["blocking", "findings", "every"],
  ],
];

const single: [string, Record<string, unknown>, NotifyWhen[]][] = [
  ["a clean review", counts(0, 0), ["every"]],
  ["a review that reviewed nothing", reviewedNothing, ["every"]],
  ["a review with warnings only", counts(0, 2), ["findings", "every"]],
  ["a review with a critical finding", counts(1, 0), ["blocking", "findings", "every"]],
];

describe("a review's announcement", () => {
  it.each(single)("of %s goes to the channels set for it", async (_, over, whens) => {
    const { review } = await account();
    const posted = told();
    await review("run-1", over);
    expect(posted.sort()).toEqual([...whens].sort());
  });
});

describe("the daily digest", () => {
  it.each(cases)("of a day of %s goes to the channels set for them", async (_, reviews, whens) => {
    const { review } = await account();
    for (const [i, over] of reviews.entries()) await review(`run-${i}`, over);
    const posted = told();
    await runDigests(db, out, new Date(Date.now() + DAY));
    expect(posted.sort()).toEqual([...whens].sort());
  });
});

describe("the weekly report", () => {
  it.each(cases)("of a week of %s goes to the channels set for them", async (_, reviews, whens) => {
    const { review, reportAt } = await account();
    for (const [i, over] of reviews.entries()) await review(`run-${i}`, over);
    const posted = told();
    await runReports(db, out, reportAt);
    expect(posted.sort()).toEqual([...whens].sort());
  });
});

describe("a digest or report that names merges", () => {
  it("goes to every channel that takes it, its reviews clean or not", async () => {
    const { review, merged, reportAt } = await account();
    await review("run-1", counts(0, 0));
    await merged();
    const posted = told();
    await runDigests(db, out, new Date(Date.now() + DAY));
    await runReports(db, out, reportAt);
    expect(posted.sort()).toEqual([
      "blocking",
      "blocking",
      "every",
      "every",
      "findings",
      "findings",
    ]);
  });
});
