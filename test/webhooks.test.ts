import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { KEPT_DELIVERIES } from "../src/notify/deliveries.js";
import { retryNotifications } from "../src/notify/notify.js";
import { webhookSignature } from "../src/notify/webhooks.js";
import { TEST_BINDINGS } from "./bindings.js";
import { finding, upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

// A webhook channel: only an https address of a public host is taken, its
// signing secret is answered once, each event is posted as versioned,
// signed JSON with its delivery id and timestamp, a redirect is never
// followed, a failed attempt is tried again with backoff, and the delivery
// log keeps how each went without a body.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const HOOK = "https://hooks.example.com/ocra?team=core";

type Posted = { url: string; headers: Headers; body: string; redirect: string };

/** Answers every call with the next of `answers` (the last one again), and records it. */
function endpoint(...answers: (() => Response)[]) {
  const posted: Posted[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push({
      url: req.url,
      headers: req.headers,
      body: await req.text(),
      redirect: init?.redirect ?? "follow",
    });
    const answer = answers[Math.min(posted.length - 1, answers.length - 1)];
    return answer ? answer() : new Response("ok");
  });
  return posted;
}

const add = (auth: Record<string, string>, json: Record<string, unknown>) =>
  call("/api/notifications/channels", { method: "POST", auth, json });

async function addHook(auth: Record<string, string>, over: Record<string, unknown> = {}) {
  const res = await add(auth, { kind: "webhook", name: "ci", when: "every", url: HOOK, ...over });
  expect(res.status).toBe(200);
  return (await res.json()) as { channel: { id: string; last4: string }; secret: string };
}

const deliveries = async (auth: Record<string, string>, id: string) =>
  (
    (await (await call(`/api/notifications/channels/${id}/deliveries`, { auth })).json()) as {
      deliveries: Record<string, unknown>[];
    }
  ).deliveries;

describe("a webhook's signature", () => {
  it("is HMAC-SHA256 of the timestamp, a dot and the body, under the channel's secret", async () => {
    expect(
      await webhookSignature("ocra_whsec_test-vector", 1700000000, '{"version":1,"event":"ping"}'),
    ).toBe("sha256=773c03c08a6d1526afe6d2a5b5384386a01bc10b48dc0c959bbf889eb3701eb5");
  });
});

describe("a webhook channel's address", () => {
  it("is refused unless it is https to a public host, after the URL is normalised", async () => {
    const { auth } = await signIn(1, "octo");
    for (const url of [
      "http://hooks.example.com/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[fe80::1]/x",
      "https://[fd00::1]/x",
      "https://2130706433/x",
      "https://0x7f000001/x",
      "https://0177.0.0.1/x",
      "https://10.0.0.8/x",
      "https://192.168.1.1/x",
      "https://100.64.0.1/x",
      "https://localhost/x",
      "https://app.localhost/x",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://localhost../x",
      "https://metadata.google.internal../computeMetadata/v1/",
      "https://app.internal../x",
      "https://intranet/x",
      "https://user:pw@hooks.example.com/x",
      "https://hooks.example.com:22/x",
      "https://hooks.example.com/x#frag",
    ]) {
      const res = await add(auth, { kind: "webhook", name: "x", when: "every", url });
      expect(res.status, url).toBe(400);
    }
    expect((await add(auth, { kind: "webhook", name: "x", when: "every", url: HOOK })).status).toBe(
      200,
    );
    expect(
      (
        await add(auth, {
          kind: "webhook",
          name: "x",
          when: "every",
          url: "https://93.184.216.34:8443/hook",
        })
      ).status,
    ).toBe(200);
  });

  it("takes no digest, weekly report or quiet hours, which are for people", async () => {
    const { auth } = await signIn(1, "octo");
    for (const over of [
      { digest: true },
      { weekly: true },
      { quietHours: { start: 22, end: 7 } },
    ]) {
      const res = await add(auth, {
        kind: "webhook",
        name: "x",
        when: "every",
        url: HOOK,
        ...over,
      });
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    const { channel } = await addHook(auth);
    const res = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth,
      json: { quietHours: { start: 22, end: 7 } },
    });
    expect(res.status).toBe(400);
  });

  it("is never answered, and its secret only when it is made or replaced", async () => {
    const { auth } = await signIn(1, "octo");
    const { channel, secret } = await addHook(auth);
    expect(secret).toMatch(/^ocra_whsec_[\w-]{43}$/);
    const listed = await (await call("/api/notifications/channels", { auth })).text();
    expect(listed).toContain(channel.id);
    expect(listed).not.toContain(secret);
    expect(listed).not.toContain("hooks.example.com");
    const rotated = await call(`/api/notifications/channels/${channel.id}/secret`, {
      method: "POST",
      auth,
    });
    const next = ((await rotated.json()) as { secret: string }).secret;
    expect(next).not.toBe(secret);
    const posted = endpoint();
    await call(`/api/notifications/channels/${channel.id}/test`, { method: "POST", auth });
    const sent = posted[0];
    const ts = Number(sent?.headers.get("ocra-timestamp"));
    expect(sent?.headers.get("ocra-signature")).toBe(
      await webhookSignature(next, ts, sent?.body ?? ""),
    );
  });
});

describe("a webhook delivery", () => {
  it("is signed, versioned JSON with its delivery id and timestamp, and follows no redirect", async () => {
    const { auth } = await signIn(1, "octo");
    const { channel, secret } = await addHook(auth);
    const posted = endpoint();
    const before = Math.floor(Date.now() / 1000);
    const res = await call(`/api/notifications/channels/${channel.id}/test`, {
      method: "POST",
      auth,
    });
    expect(await res.json()).toEqual({ delivered: true });
    const sent = posted[0];
    expect(sent?.url).toBe(HOOK);
    expect(sent?.redirect).toBe("manual");
    const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      event: "ping",
      data: { message: expect.any(String) },
    });
    expect(sent?.headers.get("ocra-delivery")).toBe(body.id);
    expect(sent?.headers.get("ocra-event")).toBe("ping");
    const ts = Number(sent?.headers.get("ocra-timestamp"));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(sent?.headers.get("ocra-signature")).toBe(
      await webhookSignature(secret, ts, sent?.body ?? ""),
    );
    expect(await deliveries(auth, channel.id)).toEqual([
      expect.objectContaining({ id: body.id, event: "ping", state: "delivered", status: 200 }),
    ]);
  });

  it("is given up on a redirect, which is not followed", async () => {
    const { auth } = await signIn(1, "octo");
    const { channel } = await addHook(auth);
    const posted = endpoint(
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    const res = await call(`/api/notifications/channels/${channel.id}/test`, {
      method: "POST",
      auth,
    });
    expect(await res.json()).toEqual({ delivered: false });
    expect(posted.map((p) => p.url)).toEqual([HOOK]);
    expect(await deliveries(auth, channel.id)).toEqual([
      expect.objectContaining({ state: "failed", error: "redirect", retryAt: null }),
    ]);
  });

  it("is tried again with backoff after a 5xx, with the same id and body", async () => {
    const web = await signIn(1, "octo");
    const { channel } = await addHook(web.auth);
    const posted = endpoint(
      () => new Response("busy", { status: 503 }),
      () => new Response("ok"),
    );
    await call(`/api/notifications/channels/${channel.id}/test`, {
      method: "POST",
      auth: web.auth,
    });
    const [pending] = await deliveries(web.auth, channel.id);
    expect(pending).toMatchObject({ state: "pending", status: 503, error: "status", attempts: 1 });
    const out = { keys: { current: TEST_BINDINGS.MASTER_KEY }, mailer: undefined };
    // Not due yet: nothing is sent.
    expect(await retryNotifications(db, out)).toBe(0);
    const later = () => new Date(Date.now() + 2 * 60_000);
    expect(await retryNotifications(db, out, later)).toBe(1);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.body).toBe(posted[0]?.body);
    expect(posted[1]?.headers.get("ocra-delivery")).toBe(posted[0]?.headers.get("ocra-delivery"));
    expect(await deliveries(web.auth, channel.id)).toEqual([
      expect.objectContaining({ state: "delivered", status: 200, attempts: 2, retryAt: null }),
    ]);
    const [row] = await scoped(db, web.account.id).list("notifyDeliveries");
    expect(row?.payload).toBeNull();
    expect(await retryNotifications(db, out, () => new Date(Date.now() + 86_400_000))).toBe(0);
  });

  it("keeps only the channel's newest deliveries, a pending one included", async () => {
    const { auth, account } = await signIn(1, "octo");
    const { channel } = await addHook(auth);
    endpoint(() => new Response("busy", { status: 503 }));
    for (let i = 0; i < 25; i++) {
      await call(`/api/notifications/channels/${channel.id}/test`, { method: "POST", auth });
    }
    const rows = await scoped(db, account.id).list("notifyDeliveries");
    expect(rows).toHaveLength(KEPT_DELIVERIES);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });

  it("is retried in turn across channels, so one channel cannot take a whole sweep", async () => {
    const a = await signIn(1, "octo");
    const b = await signIn(2, "hubot");
    const noisy = await addHook(a.auth);
    const quiet = await addHook(b.auth);
    const start = (accountId: string, channelId: string, at: number) =>
      scoped(db, accountId).deliveries.start({
        id: crypto.randomUUID(),
        channelId,
        event: "ping",
        payload: "{}",
        leaseUntil: new Date(at),
      });
    const base = Date.now() - 60 * 60_000;
    for (let i = 0; i < 60; i++) await start(a.account.id, noisy.channel.id, base + i);
    await start(b.account.id, quiet.channel.id, base + 1_000);
    endpoint();
    const out = { keys: { current: TEST_BINDINGS.MASTER_KEY }, mailer: undefined };
    expect(await retryNotifications(db, out)).toBe(50);
    expect(
      await scoped(db, b.account.id).find("notifyDeliveries", { state: "delivered" }),
    ).toHaveLength(1);
  });

  it("is given up after a 4xx", async () => {
    const { auth } = await signIn(1, "octo");
    const { channel } = await addHook(auth);
    endpoint(() => new Response("no", { status: 404 }));
    await call(`/api/notifications/channels/${channel.id}/test`, { method: "POST", auth });
    expect(await deliveries(auth, channel.id)).toEqual([
      expect.objectContaining({ state: "failed", status: 404, error: "status" }),
    ]);
  });

  it("is another account's to see only for that account", async () => {
    const a = await signIn(1, "octo");
    const b = await signIn(2, "hubot");
    const { channel } = await addHook(a.auth);
    endpoint();
    await call(`/api/notifications/channels/${channel.id}/test`, { method: "POST", auth: a.auth });
    for (const [method, path] of [
      ["GET", "deliveries"],
      ["POST", "secret"],
      ["POST", "test"],
    ] as const) {
      const res = await call(`/api/notifications/channels/${channel.id}/${path}`, {
        method,
        auth: b.auth,
      });
      expect(res.status, path).toBe(404);
    }
    expect(await scoped(db, b.account.id).count("notifyDeliveries")).toBe(0);
    expect(await scoped(db, a.account.id).count("notifyDeliveries")).toBe(1);
  });
});

describe("an uploaded review", () => {
  it("is posted with its counts, and finding titles only when the account shares them", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await addHook(web.auth);
    const posted = endpoint();
    await call("/api/reviews", { method: "POST", auth: cli.auth, json: upload("run-1", []) });
    const first = JSON.parse(posted[0]?.body ?? "{}") as Record<string, Record<string, unknown>>;
    expect(first).toMatchObject({
      version: 1,
      event: "review_completed",
      data: { review: { critical: 1, warning: 0, suggestion: 0 }, pull: null },
    });
    expect(first.data).not.toHaveProperty("findings");
    const shared = await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    expect(shared.status).toBe(200);
    posted.length = 0;
    await call("/api/reviews", {
      method: "POST",
      auth: cli.auth,
      json: upload("run-2", [finding()]),
    });
    const body = posted[0]?.body ?? "";
    expect(JSON.parse(body)).toMatchObject({
      data: {
        findings: [{ severity: "critical", title: "SQL built from input", file: "src/db.ts" }],
      },
    });
    // The code and the finding's text never leave.
    expect(body).not.toContain("SELECT * FROM");
    expect(body).not.toContain("concatenates");
  });
});
