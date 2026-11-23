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
// channels; the token is sent only to Slack, the member never answered, and
// nothing answered says whether an address or ID is a member's.

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
      channel: { kind: "slack_dm", confirmed: false, last4: ".com" },
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

  it("answer the same whether the member exists, is a bot, is deactivated or is nobody", async () => {
    const ann = (await signIn(1, "ann")).auth;
    // Each account sends 10 links a day: the member ID cases are bob's.
    const bob = (await signIn(2, "bob")).auth;
    /** What adding answers and the listing shows, without what differs by channel. */
    const seen = async (member: string, answers: Answers, auth = ann) => {
      const calls = slack(answers);
      const res = await add(auth, member);
      const { channel, ...rest } = (await res.json()) as {
        channel: { id: string; createdAt: string };
      };
      const { id, createdAt, ...view } = channel;
      const listed = (
        (await (await call("/api/notifications/channels", { auth }, SLACK)).json()) as {
          channels: { id: string; createdAt: string }[];
        }
      ).channels.find((ch) => ch.id === id);
      const { id: _, createdAt: __, ...listedView } = listed ?? { id: "", createdAt: "" };
      const resent = await call(
        `/api/notifications/channels/${id}/confirm`,
        { method: "POST", auth },
        SLACK,
      );
      vi.restoreAllMocks();
      return {
        seen: { status: res.status, rest, view, listedView, resent: await resent.json() },
        posted: calls.filter((c) => c.method === "chat.postMessage").length,
      };
    };
    const missing = { error: "users_not_found" };
    const member = await seen("ann@example.com", {});
    const nobody = await seen("ann@example.com", {
      "users.lookupByEmail": () => Response.json({ ok: false, ...missing }),
    });
    const bot = await seen("ann@example.com", {
      "users.lookupByEmail": ok({ user: { id: "U0BOT1234", is_bot: true } }),
    });
    const gone = await seen("ann@example.com", {
      "users.lookupByEmail": ok({ user: { id: "U0GONE123", deleted: true } }),
    });
    expect(member.seen).toMatchObject({
      status: 200,
      rest: { confirmationSent: true },
      view: { kind: "slack_dm", confirmed: false, last4: ".com", lastStatus: null },
      resent: { confirmationSent: true },
    });
    expect(nobody.seen).toEqual(member.seen);
    expect(bot.seen).toEqual(member.seen);
    expect(gone.seen).toEqual(member.seen);
    // Only the member was sent a link, once when added and once on request.
    expect([member.posted, nobody.posted, bot.posted, gone.posted]).toEqual([2, 0, 0, 0]);

    const byId = await seen("U012AB3CD", {}, bob);
    const nobodyById = await seen(
      "U012AB3CD",
      {
        "users.info": () => Response.json({ ok: false, error: "user_not_found" }),
      },
      bob,
    );
    expect(byId.seen).toMatchObject({ status: 200, view: { last4: "B3CD" } });
    expect(nobodyById.seen).toEqual(byId.seen);
  });

  it("refuse only what is no member ID or email address, and say when Slack is unreachable", async () => {
    const { auth } = await signIn(1, "ann");
    const calls = slack();
    const invalid = await add(auth, "#general");
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("not a Slack member ID or email address");
    expect(calls).toEqual([]);
    vi.restoreAllMocks();

    slack({ "users.lookupByEmail": () => Response.json({ ok: false, error: "invalid_auth" }) });
    const refused = await add(auth, "ann@example.com");
    expect(await refused.json()).toMatchObject({ error: "upstream_unreachable" });
    const listed = await call("/api/notifications/channels", { auth }, SLACK);
    expect(((await listed.json()) as { channels: unknown[] }).channels).toEqual([]);
  });

  it("look up at most 20 members a day per account", async () => {
    const { auth } = await signIn(1, "ann");
    const other = await signIn(2, "bob");
    const calls = slack();
    const lookups = () => calls.filter((c) => c.method === "users.info").length;
    // A channel's add and removal, so the account's 10 channels do not stop it first.
    const tryOnce = async (who: Record<string, string>) => {
      const res = await add(who, "U012AB3CD");
      if (res.status === 200) {
        const id = ((await res.json()) as { channel: { id: string } }).channel.id;
        await call(`/api/notifications/channels/${id}`, { method: "DELETE", auth: who });
        return 200;
      }
      return res;
    };
    for (let i = 0; i < 20; i++) expect(await tryOnce(auth)).toBe(200);
    expect(lookups()).toBe(20);
    const over = await tryOnce(auth);
    expect(over).toBeInstanceOf(Response);
    const res = over as Response;
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "daily_limit", limit: 20 });
    expect(lookups()).toBe(20);
    expect(await tryOnce(other.auth)).toBe(200);
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
