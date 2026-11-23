import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { masterKeys } from "../src/keyring.js";
import { retryNotifications } from "../src/notify/notify.js";
import { call, db, ORIGIN, resetDb, signIn } from "./helpers.js";

// A Slack member's direct messages: only on a server with a Slack app's
// token, found by the email address or member ID typed, sent nothing but a
// link to confirm until the member opens it, then every message in their
// conversation with the app, through the same delivery queue as the other
// channels; the token is sent only to Slack, the member never answered.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const TOKEN = "xoxb-test-slack-token";
const SLACK = { SLACK_BOT_TOKEN: TOKEN };
const MINUTES = (n: number) => () => new Date(Date.now() + n * 60_000);

type SlackCall = { method: string; params: URLSearchParams; auth: string | null };
type Answers = Partial<Record<string, () => Response>>;

const ok = (body: Record<string, unknown>) => () => Response.json({ ok: true, ...body });
const MEMBER = { user: { id: "U012AB3CD", deleted: false, is_bot: false } };
const DM = { channel: { id: "D024BE91L" } };

/** Answers each Slack method from `answers` (a posted message ok unless given), and records the calls. */
function slack(answers: Answers = {}) {
  const calls: SlackCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    expect(url.origin).toBe("https://slack.com");
    const method = url.pathname.replace("/api/", "");
    calls.push({
      method,
      params: new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer())),
      auth: req.headers.get("authorization"),
    });
    const answer =
      answers[method] ??
      {
        "users.lookupByEmail": ok(MEMBER),
        "users.info": ok(MEMBER),
        "conversations.open": ok(DM),
        "chat.postMessage": ok({}),
      }[method];
    return answer ? answer() : new Response("unknown", { status: 404 });
  });
  return calls;
}

const add = (auth: Record<string, string>, member: string, bindings: Partial<Env> = SLACK) =>
  call(
    "/api/notifications/channels",
    { method: "POST", auth, json: { kind: "slack_dm", name: "me", when: "every", member } },
    bindings,
  );

const sendTest = (auth: Record<string, string>, id: string) =>
  call(`/api/notifications/channels/${id}/test`, { method: "POST", auth }, SLACK);

const confirmLink = (c: SlackCall | undefined) =>
  c?.params.get("text")?.match(new RegExp(`${ORIGIN}(/api/email/confirm\\?t=[^|>\\s]+)`))?.[1] ??
  "";

/** A slack_dm channel added and confirmed; its id. */
async function confirmedChannel(auth: Record<string, string>) {
  const calls = slack();
  const res = await add(auth, "ann@example.com");
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { channel: { id: string } }).channel.id;
  const link = confirmLink(calls.at(-1));
  expect((await call(link, { method: "POST" })).status).toBe(200);
  vi.restoreAllMocks();
  return id;
}

describe("Slack direct messages", () => {
  it("are off, and refused, on a server without a Slack token", async () => {
    const { auth } = await signIn(1, "ann");
    const calls = slack();
    const listed = await call("/api/notifications/channels", { auth });
    expect(await listed.json()).toMatchObject({ slack: false });
    const res = await add(auth, "ann@example.com", {});
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not send Slack direct messages");
    expect(calls).toEqual([]);

    const on = await call("/api/notifications/channels", { auth }, SLACK);
    expect(await on.json()).toMatchObject({ slack: true });
  });

  it("find the member by email, open their conversation, and send only a link to confirm", async () => {
    const { auth, account } = await signIn(1, "ann");
    const calls = slack();
    const res = await add(auth, " ann@Example.com ");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { id: string; kind: string; last4: string } };
    expect(body).toMatchObject({
      channel: { kind: "slack_dm", confirmed: false, last4: "B3CD" },
      confirmationSent: true,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "users.lookupByEmail",
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[0]?.params.get("email")).toBe("ann@example.com");
    expect(calls[1]?.params.get("users")).toBe("U012AB3CD");
    expect(calls[2]?.params.get("channel")).toBe("D024BE91L");
    const link = confirmLink(calls[2]);
    expect(link).not.toBe("");
    const listed = await (await call("/api/notifications/channels", { auth }, SLACK)).text();
    expect(listed).not.toContain("U012AB3CD");
    expect(listed).not.toContain("D024BE91L");
    expect(listed).not.toContain(TOKEN);

    // Unconfirmed: a test message is refused and nothing goes.
    const before = calls.length;
    expect((await sendTest(auth, body.channel.id)).status).toBe(400);
    expect(calls).toHaveLength(before);

    expect((await call(link, { method: "POST" })).status).toBe(200);
    const row = await scoped(db, account.id).get("notifyChannels", body.channel.id);
    expect(row?.confirmedAt).not.toBeNull();
    expect(await (await sendTest(auth, body.channel.id)).json()).toEqual({ delivered: true });
    const sent = calls.at(-1);
    expect(sent?.method).toBe("chat.postMessage");
    expect(sent?.params.get("channel")).toBe("D024BE91L");
    expect(sent?.params.get("text")).toContain("this channel is connected");
  });

  it("send a new link on request, and the old one no longer confirms", async () => {
    const { auth, account } = await signIn(1, "ann");
    const calls = slack();
    const res = await add(auth, "ann@example.com");
    const id = ((await res.json()) as { channel: { id: string } }).channel.id;
    const first = confirmLink(calls.at(-1));
    const again = await call(
      `/api/notifications/channels/${id}/confirm`,
      { method: "POST", auth },
      SLACK,
    );
    expect(await again.json()).toEqual({ confirmationSent: true });
    const sent = calls.at(-1);
    expect(sent?.params.get("channel")).toBe("D024BE91L");
    const second = confirmLink(sent);
    expect(second).not.toBe(first);
    expect((await call(first, { method: "POST" })).status).toBe(404);
    expect((await call(second, { method: "POST" })).status).toBe(200);
    expect((await scoped(db, account.id).get("notifyChannels", id))?.confirmedAt).not.toBeNull();
  });

  it("find a member by their member ID", async () => {
    const { auth } = await signIn(1, "ann");
    const calls = slack();
    expect((await add(auth, "U012AB3CD")).status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "users.info" });
    expect(calls[0]?.params.get("user")).toBe("U012AB3CD");
  });

  it("refuse what is no member, a bot or a deactivated member, and say when Slack is unreachable", async () => {
    const { auth } = await signIn(1, "ann");
    slack({ "users.lookupByEmail": () => Response.json({ ok: false, error: "users_not_found" }) });
    const missing = await add(auth, "nobody@example.com");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("no member of the Slack workspace");
    vi.restoreAllMocks();

    slack({ "users.info": ok({ user: { id: "U0BOT1234", is_bot: true } }) });
    expect((await add(auth, "U0BOT1234")).status).toBe(400);
    vi.restoreAllMocks();

    slack({ "users.info": ok({ user: { id: "U0GONE123", deleted: true } }) });
    expect((await add(auth, "U0GONE123")).status).toBe(400);
    vi.restoreAllMocks();

    const calls = slack();
    expect((await add(auth, "#general")).status).toBe(400);
    expect(calls).toEqual([]);
    vi.restoreAllMocks();

    slack({ "users.lookupByEmail": () => Response.json({ ok: false, error: "invalid_auth" }) });
    const refused = await add(auth, "ann@example.com");
    expect(await refused.json()).toMatchObject({ error: "upstream_unreachable" });
    const listed = await call("/api/notifications/channels", { auth }, SLACK);
    expect(((await listed.json()) as { channels: unknown[] }).channels).toEqual([]);
  });

  it("are tried again after Slack's rate limit, and given up when the member is deactivated", async () => {
    const { auth } = await signIn(1, "ann");
    const id = await confirmedChannel(auth);

    slack({ "chat.postMessage": () => new Response("", { status: 429 }) });
    expect(await (await sendTest(auth, id)).json()).toEqual({ delivered: false });
    const log = async () =>
      (
        (await (await call(`/api/notifications/channels/${id}/deliveries`, { auth })).json()) as {
          deliveries: Record<string, unknown>[];
        }
      ).deliveries;
    expect((await log())[0]).toMatchObject({ state: "pending", status: 429 });
    vi.restoreAllMocks();

    // The retry sweep sends it with the server's token.
    const calls = slack();
    const keys = masterKeys(env);
    expect(
      await retryNotifications(db, { keys, mailer: undefined, slack: TOKEN }, MINUTES(2)),
    ).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["chat.postMessage"]);
    expect((await log())[0]).toMatchObject({ state: "delivered", attempts: 2 });
    vi.restoreAllMocks();

    slack({ "chat.postMessage": () => Response.json({ ok: false, error: "account_inactive" }) });
    expect(await (await sendTest(auth, id)).json()).toEqual({ delivered: false });
    expect((await log())[0]).toMatchObject({ state: "failed", error: "rejected" });
  });
});
