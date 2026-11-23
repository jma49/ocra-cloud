import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { runDigests } from "../src/notify/digest.js";
import type { Mail, Mailer } from "../src/notify/email.js";
import { type Outbox, retryNotifications } from "../src/notify/notify.js";
import { upload } from "./finding-uploads.js";
import { type CallInit, call, db, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";

// Every channel kind's messages go through the delivery queue: each keeps
// its id on every attempt, a failure that may pass is tried again with
// backoff, one that cannot is given up at once, the body goes once it is
// done, and the log shows how each went to the channel's own account only,
// never the body or the address.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const WECOM = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123-4567-89ab";
const MINUTES = (n: number) => () => new Date(Date.now() + n * 60_000);

/** Answers every chat call with the next of `answers` (the last one again), and records each body. */
function chat(...answers: (() => Response)[]) {
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    bodies.push(await new Request(input, init).text());
    const answer = answers[Math.min(bodies.length - 1, answers.length - 1)];
    return answer ? answer() : new Response("ok");
  });
  return bodies;
}

const add = (auth: Record<string, string>, json: Record<string, unknown>) =>
  call("/api/notifications/channels", { method: "POST", auth, json });

async function addChat(auth: Record<string, string>, kind: "slack" | "wecom", url: string) {
  const res = await add(auth, { kind, name: "team", when: "every", url });
  expect(res.status).toBe(200);
  return ((await res.json()) as { channel: { id: string } }).channel.id;
}

const test = (auth: Record<string, string>, id: string) =>
  call(`/api/notifications/channels/${id}/test`, { method: "POST", auth });

type Delivery = Record<string, unknown> & { id: string };
async function deliveries(auth: Record<string, string>, id: string): Promise<Delivery[]> {
  const res = await call(`/api/notifications/channels/${id}/deliveries`, { auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { deliveries: Delivery[] }).deliveries;
}

const transports = (mailer?: Mailer) => ({ keys: masterKeys(env), mailer });

describe("a chat's delivery", () => {
  it("is tried again after a 503 with the same id and body, then delivered and its body cleared", async () => {
    const { auth, account } = await signIn(1, "octo");
    const id = await addChat(auth, "slack", SLACK);
    const bodies = chat(
      () => new Response("rollup_error", { status: 503 }),
      () => new Response("ok"),
    );
    expect(await (await test(auth, id)).json()).toEqual({ delivered: false });
    const [pending] = await deliveries(auth, id);
    expect(pending).toMatchObject({ event: "ping", state: "pending", status: 503, attempts: 1 });
    expect(pending?.retryAt).toEqual(expect.any(String));

    // Not due yet: nothing is sent.
    expect(await retryNotifications(db, transports())).toBe(0);
    expect(await retryNotifications(db, transports(), MINUTES(2))).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({
        id: pending?.id,
        state: "delivered",
        status: 200,
        attempts: 2,
        retryAt: null,
      }),
    ]);
    const [row] = await scoped(db, account.id).list("notifyDeliveries");
    expect(row?.payload).toBeNull();
    expect((await scoped(db, account.id).get("notifyChannels", id))?.lastStatus).toBe("ok");
    expect(await retryNotifications(db, transports(), MINUTES(24 * 60))).toBe(0);
  });

  it("is given up at once when Slack says the webhook or its channel is gone", async () => {
    const { auth } = await signIn(1, "octo");
    const id = await addChat(auth, "slack", SLACK);
    const bodies = chat(
      () => new Response("invalid_token", { status: 403 }),
      () => new Response("channel_not_found", { status: 404 }),
      // Slack's own words outrank its status.
      () => new Response("channel_not_found", { status: 500 }),
    );
    for (let i = 0; i < 3; i++) await test(auth, id);
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "failed", status: 500, error: "status", retryAt: null }),
      expect.objectContaining({ state: "failed", status: 404, error: "status", retryAt: null }),
      expect.objectContaining({ state: "failed", status: 403, error: "status", retryAt: null }),
    ]);
    expect(await retryNotifications(db, transports(), MINUTES(24 * 60))).toBe(0);
    expect(bodies).toHaveLength(3);
  });

  it("is tried again on Slack's rate limit, and given up after its last attempt", async () => {
    const { auth } = await signIn(1, "octo");
    const id = await addChat(auth, "slack", SLACK);
    const bodies = chat(() => new Response("rate_limited", { status: 429 }));
    await test(auth, id);
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "pending", status: 429 }),
    ]);
    for (const minutes of [2, 10, 60, 4 * 60, 10 * 60]) {
      await retryNotifications(db, transports(), MINUTES(minutes));
    }
    expect(bodies).toHaveLength(5);
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "failed", status: 429, attempts: 5, retryAt: null }),
    ]);
  });

  it("is read from WeCom's errcode: busy is tried again, a bad key given up", async () => {
    const { auth } = await signIn(1, "octo");
    const id = await addChat(auth, "wecom", WECOM);
    chat(
      () => Response.json({ errcode: 45009, errmsg: "api freq out of limit" }),
      () => Response.json({ errcode: 93000, errmsg: "invalid webhook url" }),
    );
    await test(auth, id);
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "pending", status: 200, error: "rejected" }),
    ]);
    await retryNotifications(db, transports(), MINUTES(2));
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "failed", error: "rejected", attempts: 2 }),
    ]);
  });

  it("never logs its address or body", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args));
    }
    const { auth } = await signIn(1, "octo");
    const id = await addChat(auth, "slack", SLACK);
    chat(() => {
      throw new TypeError("network down");
    });
    await test(auth, id);
    expect(await deliveries(auth, id)).toHaveLength(1);
    await retryNotifications(db, transports(), MINUTES(2));
    const text = JSON.stringify(logged);
    expect(text).not.toContain("XXXXsecret");
    expect(text).not.toContain("Test message from ocra");
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "pending", error: "network", attempts: 2 }),
    ]);
  });

  it("carries the daily digest, which is retried like any message", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const res = await add(web.auth, {
      kind: "slack",
      name: "team",
      when: "blocking",
      url: SLACK,
      digest: true,
    });
    const id = ((await res.json()) as { channel: { id: string } }).channel.id;
    // The review's own announcement is taken; the digest's first attempt is not.
    const bodies = chat(
      () => new Response("ok"),
      () => new Response("rollup_error", { status: 500 }),
      () => new Response("ok"),
    );
    await call("/api/reviews", { method: "POST", auth: cli.auth, json: upload("run-1", []) });
    const out: Outbox = {
      keys: masterKeys(env),
      mailer: undefined,
      linkSecret: env.SESSION_SECRET,
      origin: ORIGIN,
    };
    await runDigests(db, out, new Date(Date.now() + 24 * 60 * 60_000));
    const digest = async () => (await deliveries(web.auth, id)).filter((d) => d.event === "digest");
    expect(await digest()).toEqual([expect.objectContaining({ state: "pending", status: 500 })]);
    await retryNotifications(db, transports(), MINUTES(2));
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toBe(bodies[1]);
    expect(await digest()).toEqual([expect.objectContaining({ state: "delivered", attempts: 2 })]);
  });
});

describe("a channel's deliveries", () => {
  it("are another account's to see only for that account", async () => {
    const a = await signIn(1, "octo");
    const b = await signIn(2, "hubot");
    const id = await addChat(a.auth, "slack", SLACK);
    chat(() => new Response("busy", { status: 503 }));
    await test(a.auth, id);
    expect(await deliveries(a.auth, id)).toHaveLength(1);
    const res = await call(`/api/notifications/channels/${id}/deliveries`, { auth: b.auth });
    expect(res.status).toBe(404);
    expect(await scoped(db, b.account.id).count("notifyDeliveries")).toBe(0);
    expect(await scoped(db, a.account.id).count("notifyDeliveries")).toBe(1);
  });

  it("go with their channel", async () => {
    const { auth, account } = await signIn(1, "octo");
    const id = await addChat(auth, "slack", SLACK);
    chat(() => new Response("busy", { status: 503 }));
    await test(auth, id);
    expect(await deliveries(auth, id)).toHaveLength(1);
    await call(`/api/notifications/channels/${id}`, { method: "DELETE", auth });
    expect(await scoped(db, account.id).count("notifyDeliveries")).toBe(0);
    expect(await retryNotifications(db, transports(), MINUTES(2))).toBe(0);
  });
});

/** A mailer that answers each send with the next of `answers` (the last one again). */
function mailer(...answers: (() => boolean)[]) {
  const sent: Mail[] = [];
  return {
    sent,
    mailer: {
      async send(mail: Mail) {
        sent.push(mail);
        const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
        return answer ? answer() : true;
      },
    },
  };
}

/** An SMTP refusal as nodemailer throws it. */
const smtp = (responseCode: number) => () => {
  throw Object.assign(new Error(`${responseCode} refused for ann@example.com`), { responseCode });
};

async function emailChannel(m: Mailer) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    mailer: m,
  });
  const fetchApp = async (path: string, init: CallInit = {}) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(request(path, init), env, ctx);
    const body = await res.arrayBuffer();
    await waitOnExecutionContext(ctx);
    return new Response(body, { status: res.status, headers: res.headers });
  };
  const { auth, account } = await signIn(1, "octo");
  const added = await fetchApp("/api/notifications/channels", {
    method: "POST",
    auth,
    json: { kind: "email", name: "me", when: "every", address: "ann@example.com" },
  });
  const id = ((await added.json()) as { channel: { id: string } }).channel.id;
  await scoped(db, account.id).update("notifyChannels", id, { confirmedAt: new Date() });
  return { auth, account, id, fetchApp };
}

describe("an email's delivery", () => {
  it("is tried again after a 4xx reply, with the same message, then delivered", async () => {
    const m = mailer(
      () => true,
      smtp(451),
      () => true,
    );
    const { auth, account, id, fetchApp } = await emailChannel(m.mailer);
    await fetchApp(`/api/notifications/channels/${id}/test`, { method: "POST", auth });
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "pending", status: 451, error: "status", attempts: 1 }),
    ]);
    const [row] = await scoped(db, account.id).list("notifyDeliveries");
    expect(row?.payload).not.toContain("ann@example.com");
    await retryNotifications(db, transports(m.mailer), MINUTES(2));
    // The confirmation, then the test twice.
    expect(m.sent).toHaveLength(3);
    expect(m.sent[2]).toEqual(m.sent[1]);
    expect(m.sent[2]?.to).toBe("ann@example.com");
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "delivered", status: null, error: null, attempts: 2 }),
    ]);
  });

  it("is given up at once after a 5xx reply", async () => {
    const m = mailer(() => true, smtp(550));
    const { auth, id, fetchApp } = await emailChannel(m.mailer);
    await fetchApp(`/api/notifications/channels/${id}/test`, { method: "POST", auth });
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "failed", status: 550, error: "status", retryAt: null }),
    ]);
    expect(await retryNotifications(db, transports(m.mailer), MINUTES(24 * 60))).toBe(0);
    expect(m.sent).toHaveLength(2);
  });

  it("goes when its address is unsubscribed, pending or not", async () => {
    const m = mailer(() => true, smtp(451));
    const { auth, account, id, fetchApp } = await emailChannel(m.mailer);
    await fetchApp(`/api/notifications/channels/${id}/test`, { method: "POST", auth });
    expect(await deliveries(auth, id)).toEqual([expect.objectContaining({ state: "pending" })]);
    const link = m.sent[1]?.text.match(new RegExp(`${ORIGIN}(/api/email/unsubscribe\\?t=\\S+)`));
    expect((await fetchApp(link?.[1] ?? "", { method: "POST" })).status).toBe(200);
    expect(await scoped(db, account.id).count("notifyDeliveries")).toBe(0);
    expect(await retryNotifications(db, transports(m.mailer), MINUTES(2))).toBe(0);
  });

  it("is given up on a host with no mailer, when one is due", async () => {
    const m = mailer(() => true, smtp(421));
    const { auth, id, fetchApp } = await emailChannel(m.mailer);
    await fetchApp(`/api/notifications/channels/${id}/test`, { method: "POST", auth });
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "pending", status: 421 }),
    ]);
    await retryNotifications(db, transports(), MINUTES(2));
    expect(await deliveries(auth, id)).toEqual([
      expect.objectContaining({ state: "failed", error: "refused", attempts: 2 }),
    ]);
  });
});
