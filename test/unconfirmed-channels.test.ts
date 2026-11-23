import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { enforceRetention } from "../src/db/retention.js";
import { scoped } from "../src/db/scoped.js";
import type { Mail } from "../src/notify/email.js";
import { DAY } from "../src/time.js";
import { type CallInit, db, ORIGIN, request, resetDb, signIn } from "./helpers.js";
import { rows } from "./table-rows.js";

// A channel that needs confirming and is never confirmed frees its place under the
// cap: the daily retention deletes it UNCONFIRMED_DAYS after its last link,
// the same way whether or not its Slack member exists.

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const MINUTE = 60_000;
/** UNCONFIRMED_DAYS in src/db/notify.ts. */
const UNCONFIRMED_DAYS = 7;
const SLACK = { SLACK_BOT_TOKEN: "xoxb-test-slack-token" };

/** The app with a mailer that keeps what it is given and a Slack token; Slack answers `found`. */
function server(found: () => boolean) {
  const sent: Mail[] = [];
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    mailer: {
      async send(m: Mail) {
        sent.push(m);
        return true;
      },
    },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const method = new URL(new Request(input).url).pathname.replace("/api/", "");
    if (method === "users.lookupByEmail") {
      return Response.json(
        found()
          ? { ok: true, user: { id: "U012AB3CD", deleted: false, is_bot: false } }
          : { ok: false, error: "users_not_found" },
      );
    }
    if (method === "conversations.open") return Response.json({ ok: true, channel: { id: "D1" } });
    return Response.json({ ok: true });
  });
  const call = async (path: string, init: CallInit = {}) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(request(path, init), { ...env, ...SLACK }, ctx);
    const body = await res.arrayBuffer();
    await waitOnExecutionContext(ctx);
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return { sent, call };
}

const at = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
};

describe("a channel never confirmed", () => {
  it(`is deleted ${UNCONFIRMED_DAYS} days after its last link, member or not, and a resend starts again`, async () => {
    const t0 = Date.now();
    at(t0);
    const { auth, account } = await signIn(1, "ann");
    let member = true;
    const { sent, call } = server(() => member);
    const add = async (json: Record<string, unknown>) => {
      const res = await call("/api/notifications/channels", {
        method: "POST",
        auth,
        json: { name: "n", when: "every", ...json },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { channel: { id: string } }).channel.id;
    };
    const slackMember = await add({ kind: "slack_dm", member: "ann@example.com" });
    member = false;
    const slackNobody = await add({ kind: "slack_dm", member: "bob@example.com" });
    const email = await add({ kind: "email", address: "ann@example.com" });
    const resent = await add({ kind: "email", address: "cat@example.com" });
    const confirmed = await add({ kind: "email", address: "dan@example.com" });
    const link = sent.at(-1)?.text.match(new RegExp(`${ORIGIN}(/api/email/confirm\\?t=\\S+)`));
    expect((await call(link?.[1] ?? "", { method: "POST" })).status).toBe(200);
    const chat = await add({ kind: "slack", url: "https://hooks.slack.com/services/T0/B0/XXXX" });
    const d = scoped(db, account.id);
    // One whose link never went (the day's cap was reached) counts from when it was added.
    await d.insert("notifyChannels", { ...rows.notifyChannels("unsent"), kind: "email" });

    at(t0 + 5 * DAY);
    const again = await call(`/api/notifications/channels/${resent}/confirm`, {
      method: "POST",
      auth,
    });
    expect(await again.json()).toEqual({ confirmationSent: true });

    const ids = async () => (await d.list("notifyChannels")).map((c) => c.id).sort();
    const all = [slackMember, slackNobody, email, resent, confirmed, chat, "unsent"].sort();
    await enforceRetention(db, new Date(t0 + UNCONFIRMED_DAYS * DAY - MINUTE));
    expect(await ids()).toEqual(all);

    await enforceRetention(db, new Date(t0 + UNCONFIRMED_DAYS * DAY + MINUTE));
    expect(await ids()).toEqual([resent, confirmed, chat].sort());
    const expired = (await d.list("auditEvents"))
      .filter((e) => e.kind === "channel.expired")
      .map((e) => e.detail);
    expect(expired).toHaveLength(4);
    expect(expired).toEqual(
      expect.arrayContaining([
        { channel: slackMember, kind: "slack_dm" },
        { channel: slackNobody, kind: "slack_dm" },
        { channel: email, kind: "email" },
        { channel: "unsent", kind: "email" },
      ]),
    );

    await enforceRetention(db, new Date(t0 + (5 + UNCONFIRMED_DAYS) * DAY + MINUTE));
    expect(await ids()).toEqual([confirmed, chat].sort());
  });

  it("answers when it may be removed, the same for a member or not, and a resend moves it", async () => {
    const t0 = Date.now();
    at(t0);
    const { auth, account } = await signIn(1, "ann");
    let member = true;
    const { sent, call } = server(() => member);
    const add = async (json: Record<string, unknown>) => {
      const res = await call("/api/notifications/channels", {
        method: "POST",
        auth,
        json: { name: "n", when: "every", ...json },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { channel: { id: string } }).channel.id;
    };
    const slackMember = await add({ kind: "slack_dm", member: "ann@example.com" });
    member = false;
    const slackNobody = await add({ kind: "slack_dm", member: "bob@example.com" });
    const email = await add({ kind: "email", address: "cat@example.com" });
    const confirmed = await add({ kind: "email", address: "dan@example.com" });
    const link = sent.at(-1)?.text.match(new RegExp(`${ORIGIN}(/api/email/confirm\\?t=\\S+)`));
    expect((await call(link?.[1] ?? "", { method: "POST" })).status).toBe(200);
    const chat = await add({ kind: "slack", url: "https://hooks.slack.com/services/T0/B0/XXXX" });
    const hook = await add({ kind: "webhook", url: "https://example.com/hook" });
    await scoped(db, account.id).insert("notifyChannels", {
      ...rows.notifyChannels("unsent"),
      kind: "email",
      createdAt: new Date(t0),
    });

    const removesAt = async () => {
      const res = await call("/api/notifications/channels", { auth });
      const { channels } = (await res.json()) as {
        channels: { id: string; removesAt: string | null }[];
      };
      return Object.fromEntries(channels.map((c) => [c.id, c.removesAt]));
    };
    const week = new Date(t0 + UNCONFIRMED_DAYS * DAY).toISOString();
    expect(await removesAt()).toEqual({
      [slackMember]: week,
      [slackNobody]: week,
      [email]: week,
      unsent: week,
      [confirmed]: null,
      [chat]: null,
      [hook]: null,
    });

    at(t0 + 5 * DAY);
    const again = await call(`/api/notifications/channels/${email}/confirm`, {
      method: "POST",
      auth,
    });
    expect(await again.json()).toEqual({ confirmationSent: true });
    expect((await removesAt())[email]).toBe(
      new Date(t0 + (5 + UNCONFIRMED_DAYS) * DAY).toISOString(),
    );
  });

  it("is never one a link confirms meanwhile", async () => {
    const { account } = await signIn(1, "ann");
    const d = scoped(db, account.id);
    const old = new Date(Date.now() - 30 * DAY);
    await d.insert("notifyChannels", {
      ...rows.notifyChannels("kept"),
      kind: "slack_dm",
      createdAt: old,
      confirmExpiresAt: old,
      confirmedAt: new Date(),
    });
    await enforceRetention(db);
    expect((await d.list("notifyChannels")).map((c) => c.id)).toEqual(["kept"]);
  });
});
