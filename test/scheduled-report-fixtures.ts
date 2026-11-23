import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import type { Outbox } from "../src/notify/notify.js";
import { hourIn } from "../src/notify/reminders.js";
import { HOUR } from "../src/time.js";
import { finding, upload } from "./finding-uploads.js";
import { call, db, ORIGIN, signIn, signInCli } from "./helpers.js";

// What the scheduled reports' tests share: an account in Tokyo with a Slack
// channel and two enrolled repositories, its reviews and merges.

export const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";

export const out: Outbox = {
  keys: masterKeys(env),
  mailer: undefined,
  linkSecret: env.SESSION_SECRET,
  origin: ORIGIN,
};

/** What Slack is sent that starts with prefix; a review's own notice is left out. */
export function slack(prefix = "ocra's report") {
  const posted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const text = String(((await req.json()) as { text: string }).text);
    if (text.startsWith(prefix)) posted.push(text);
    return new Response("ok");
  });
  return posted;
}

/** An account in Tokyo with a Slack channel and two enrolled repositories. */
export async function account() {
  const web = await signIn(1, "octo");
  const cli = await signInCli(1, "octo");
  await call("/api/account/sharing", {
    method: "PUT",
    auth: web.auth,
    headers: { origin: ORIGIN },
    json: { enabled: true },
  });
  await call("/api/notifications/time-zone", {
    method: "PUT",
    auth: web.auth,
    json: { timeZone: "Asia/Tokyo" },
  });
  const added = await call("/api/notifications/channels", {
    method: "POST",
    auth: web.auth,
    json: { kind: "slack", name: "team", when: "blocking", url: SLACK },
  });
  const channel = ((await added.json()) as { channel: { id: string } }).channel.id;
  const data = scoped(db, web.account.id);
  const api = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "11",
    fullName: "octo/api",
  });
  const site = await data.insert("reviewRepos", {
    platform: "github",
    host: "github.com",
    platformRepoId: "12",
    fullName: "octo/site",
  });
  return { web, cli, channel, data, api, site };
}

export async function review(
  cli: { auth: Record<string, string> },
  runId: string,
  repo: string,
  critical: boolean,
) {
  const res = await call("/api/reviews", {
    method: "POST",
    auth: cli.auth,
    json: {
      ...upload(runId, critical ? [finding({ title: `Unchecked input in ${repo}` })] : []),
      pullRequest: { repository: `https://github.com/${repo}`, number: 7, headSha: "a".repeat(40) },
      outcomes: { fixed: 1, dismissed: 0 },
    },
  });
  expect(res.status).toBe(200);
}

export async function merged(data: ReturnType<typeof scoped>, repoId: string, number: number) {
  const closedAt = new Date(Date.now() - 1000);
  await data.closedPulls.record({
    reviewRepoId: repoId,
    number,
    title: `Pull ${number}`,
    merged: true,
    openedAt: new Date(closedAt.getTime() - 2 * HOUR),
    closedAt,
  });
}

export const nextHourInTokyo = () => (hourIn(new Date(), "Asia/Tokyo") + 1) % 24;
