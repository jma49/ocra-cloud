import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { reviewMessage } from "../src/notify/channels.js";
import { runDigests } from "../src/notify/digest.js";
import { emailAddress, type Mail, mailOf, sendMail } from "../src/notify/email.js";
import type { Outbox } from "../src/notify/notify.js";
import { finding, upload } from "./finding-uploads.js";
import { type CallInit, call, db, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";

// Email channels and the daily digest: an address is taken only as one
// plain mailbox and gets nothing until the link mailed to it is opened;
// every email can be unsubscribed from without signing in; and the digest
// goes once per account and day, however many runs race for it.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** A mailer that keeps what it is given. */
function outbox() {
  const sent: Mail[] = [];
  const mailer = {
    async send(m: Mail) {
      sent.push(m);
      return true;
    },
  };
  return { sent, mailer };
}

function appWith(mailer: { send: (m: Mail) => Promise<boolean> }) {
  const app = createApp({
    openDb: (e: Env) => drizzle(e.DB),
    clientAddress: () => "192.0.2.1",
    mailer,
  });
  return async (path: string, init: CallInit = {}) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(request(path, init), env, ctx);
    const body = await res.arrayBuffer();
    await waitOnExecutionContext(ctx);
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

const linkIn = (mail: Mail | undefined, what: "confirm" | "unsubscribe") => {
  const m = mail?.text.match(new RegExp(`${ORIGIN}(/api/email/${what}\\?t=[^\\s]+)`));
  return m?.[1] ?? "";
};

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";

describe("an email address", () => {
  it("is one plain mailbox, its domain lowercased", () => {
    expect(emailAddress(" Ann.Lee+ocra@Example.COM ")).toBe("Ann.Lee+ocra@example.com");
    for (const bad of [
      "ann@example.com\r\nBcc: eve@evil.test",
      "ann@example.com\nSubject: x",
      "ann@example.com, eve@evil.test",
      "Ann <ann@example.com>",
      '"ann"@example.com',
      "ann@example.com/x",
      "ann@evil.test:25",
      "ann@[192.0.2.1]",
      "ann@192.0.2.1",
      "ann@localhost",
      "ann@@example.com",
      "@example.com",
      "ann@example.com.",
      `${"a".repeat(65)}@example.com`,
    ]) {
      expect(emailAddress(bad), bad).toBeUndefined();
    }
  });

  it("never gets a header that could start another", async () => {
    const { sent, mailer } = outbox();
    const mail = mailOf({ subject: "s", lines: [["x"]] }, "ann@example.com", "https://u.test/x");
    expect(await sendMail(mailer, { ...mail, subject: "hi\r\nBcc: eve@evil.test" })).toBe(false);
    expect(await sendMail(mailer, { ...mail, to: "ann@example.com\r\nBcc: eve@evil.test" })).toBe(
      false,
    );
    expect(await sendMail(mailer, { ...mail, headers: { "X-A": "1\r\nBcc: eve@evil.test" } })).toBe(
      false,
    );
    expect(sent).toHaveLength(0);
    expect(await sendMail(mailer, mail)).toBe(true);
  });

  it("gets model text escaped, a one-line subject and a one-click unsubscribe", () => {
    const m = reviewMessage({
      pull: {
        label: "octo/api#7\r\nBcc: eve@evil.test",
        url: "https://github.com/octo/api/pull/7",
      },
      critical: 1,
      warning: 0,
      suggestion: 0,
      verdict: null,
      complete: true,
      titles: [{ title: '<img src="https://evil.test/p.gif">', file: "a.ts" }],
      consoleUrl: "https://ocra.test/reviews/r1",
    });
    const mail = mailOf(m, "ann@example.com", "https://ocra.test/api/email/unsubscribe?t=x");
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain('<a href="https://ocra.test/reviews/r1">Open in ocra</a>');
    expect(mail.headers["List-Unsubscribe"]).toBe("<https://ocra.test/api/email/unsubscribe?t=x>");
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.text).toContain("Unsubscribe: https://ocra.test/api/email/unsubscribe?t=x");
  });
});

describe("email channels", () => {
  it("are refused where the server sends no email", async () => {
    const { auth } = await signIn(1, "octo");
    const res = await call("/api/notifications/channels", {
      method: "POST",
      auth,
      json: { kind: "email", name: "me", when: "every", address: "ann@example.com" },
    });
    expect(res.status).toBe(400);
    expect(await (await call("/api/notifications/channels", { auth })).json()).toMatchObject({
      email: false,
    });
  });

  it("get nothing until confirmed, then reviews, and unsubscribe in one click", async () => {
    const { sent, mailer } = outbox();
    const fetchApp = appWith(mailer);
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const added = await fetchApp("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "email", name: "me", when: "every", address: "Ann@Example.com" },
    });
    const body = (await added.json()) as { channel: { id: string; confirmed: boolean } };
    expect(body).toMatchObject({ channel: { confirmed: false }, confirmationSent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("Ann@example.com");
    const confirm = linkIn(sent[0], "confirm");
    expect(confirm).not.toBe("");
    const listed = await (await fetchApp("/api/notifications/channels", { auth: web.auth })).text();
    expect(listed).not.toContain("Ann@");
    expect(JSON.parse(listed)).toMatchObject({ email: true });

    // Unconfirmed: no review email, no test email.
    await fetchApp("/api/reviews", { method: "POST", auth: cli.auth, json: upload("run-1", []) });
    expect(sent).toHaveLength(1);
    const test = await fetchApp(`/api/notifications/channels/${body.channel.id}/test`, {
      method: "POST",
      auth: web.auth,
    });
    expect(test.status).toBe(400);
    expect(sent).toHaveLength(1);

    // Opening the link only shows a button; posting it confirms, once.
    expect((await fetchApp(confirm)).status).toBe(200);
    const unconfirmed = await scoped(db, web.account.id).get("notifyChannels", body.channel.id);
    expect(unconfirmed?.confirmedAt).toBeNull();
    expect((await fetchApp(confirm, { method: "POST" })).status).toBe(200);
    expect((await fetchApp(confirm, { method: "POST" })).status).toBe(404);

    await fetchApp("/api/reviews", { method: "POST", auth: cli.auth, json: upload("run-2", []) });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toContain("ocra reviewed");
    const unsubscribe = linkIn(sent[1], "unsubscribe");
    expect(unsubscribe).not.toBe("");

    // A forged signature is refused; the real one removes the channel.
    const forged = unsubscribe.replace(/.{4}$/, "0000");
    expect((await fetchApp(forged, { method: "POST" })).status).toBe(404);
    expect((await fetchApp(unsubscribe)).status).toBe(200);
    expect(await scoped(db, web.account.id).count("notifyChannels")).toBe(1);
    const gone = await fetchApp(unsubscribe, { method: "POST" });
    expect(gone.status).toBe(200);
    expect(await scoped(db, web.account.id).count("notifyChannels")).toBe(0);
    await fetchApp("/api/reviews", { method: "POST", auth: cli.auth, json: upload("run-3", []) });
    expect(sent).toHaveLength(2);
  });

  it("are confirmed only by their own account's unexpired token", async () => {
    const { sent, mailer } = outbox();
    const fetchApp = appWith(mailer);
    const a = await signIn(1, "octo");
    const b = await signIn(2, "hubot");
    for (const [who, address] of [
      [a, "ann@example.com"],
      [b, "bob@example.com"],
    ] as const) {
      await fetchApp("/api/notifications/channels", {
        method: "POST",
        auth: who.auth,
        json: { kind: "email", name: "me", when: "every", address },
      });
    }
    const link = linkIn(sent[0], "confirm");
    const [, token] = decodeURIComponent(link).split("?t=");
    const [, channelId, secret] = (token ?? "").split(".");
    const swapped = `/api/email/confirm?t=${encodeURIComponent(`${b.account.id}.${channelId}.${secret}`)}`;
    expect((await fetchApp(swapped, { method: "POST" })).status).toBe(404);
    const data = scoped(db, a.account.id);
    await data.update("notifyChannels", channelId ?? "", { confirmExpiresAt: new Date(1) });
    expect((await fetchApp(link, { method: "POST" })).status).toBe(404);
    expect((await data.get("notifyChannels", channelId ?? ""))?.confirmedAt).toBeNull();
  });
});

describe("the daily digest", () => {
  it("goes once per account and day, with only that account's reviews", async () => {
    const posted: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      posted.push(String(((await req.json()) as { text: string }).text));
      return new Response("ok");
    });
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const other = await signInCli(2, "hubot");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json: { enabled: true },
    });
    await call("/api/notifications/channels", {
      method: "POST",
      auth: web.auth,
      json: { kind: "slack", name: "team", when: "blocking", url: SLACK, digest: true },
    });
    const shared = upload("run-1", [finding({ title: "SQL built from input" })]);
    await call("/api/reviews", { method: "POST", auth: cli.auth, json: shared });
    for (const run of ["run-a", "run-b"]) {
      await call("/api/reviews", { method: "POST", auth: other.auth, json: upload(run, []) });
    }
    posted.length = 0;

    const out: Outbox = {
      keys: masterKeys(env),
      mailer: undefined,
      linkSecret: env.SESSION_SECRET,
      origin: ORIGIN,
    };
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Promise.all([runDigests(db, out, tomorrow), runDigests(db, out, tomorrow)]);
    await runDigests(db, out, tomorrow);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("1 review");
    expect(posted[0]).toContain("1 critical · 0 warning · 0 suggestion");
    expect(posted[0]).toContain("critical: SQL built from input");
    expect(posted[0]).toContain(`<${ORIGIN}/findings|Findings>`);
  });
});
