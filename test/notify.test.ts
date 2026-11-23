import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookUrl, messageOf, reviewMessage, whensFor } from "../src/notify/channels.js";
import { upload } from "./finding-uploads.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

// The account's chats hear about its reviews: only a chat's own webhook
// address is taken, it is never answered, and each review reaches the
// channels whose setting takes it, with model text made plain.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";
const WECOM = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123-4567-89ab";

type Posted = { url: string; body: Record<string, unknown> };

/** Answers every webhook call with `answer`, and records it. */
function chats(answer: (url: string) => Response = () => new Response("ok")) {
  const posted: Posted[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    posted.push({ url: req.url, body: (await req.json()) as Record<string, unknown> });
    return answer(req.url);
  });
  return posted;
}

const add = (auth: Record<string, string>, json: Record<string, unknown>) =>
  call("/api/notifications/channels", { method: "POST", auth, json });

describe("a channel's webhook address", () => {
  it("is taken only on its chat's own host and path", () => {
    expect(hookUrl("slack", ` ${SLACK} `)).toBe(SLACK);
    expect(hookUrl("wecom", WECOM)).toBe(WECOM);
    for (const bad of [
      "http://hooks.slack.com/services/T/B/X",
      "https://hooks.slack.com:8443/services/T/B/X",
      "https://user:pw@hooks.slack.com/services/T/B/X",
      "https://hooks.slack.com.evil.test/services/T/B/X",
      "https://hooks.slack.com/services/T/B/../../x",
      "https://internal.example/services/T/B/X",
    ]) {
      expect(hookUrl("slack", bad), bad).toBeUndefined();
    }
    expect(hookUrl("wecom", `${WECOM}&debug=1`)).toBeUndefined();
    expect(hookUrl("wecom", SLACK)).toBeUndefined();
    expect(hookUrl("slack", WECOM)).toBeUndefined();
  });
});

describe("a review's message", () => {
  const notice = {
    pull: { label: "octo/api#7", url: "https://github.com/octo/api/pull/7" },
    critical: 1,
    warning: 0,
    suggestion: 2,
    verdict: "significant_concerns",
    complete: false,
    titles: [{ title: "Leak <!channel> @all [x](https://evil.test)\nnext", file: "src/a.ts" }],
    consoleUrl: "https://ocra.test/reviews/r1",
  };

  it("links the pull request and the console, and makes model text plain", () => {
    const slack = (messageOf("slack", reviewMessage(notice)) as { text: string }).text;
    expect(slack).toContain("<https://github.com/octo/api/pull/7|octo/api#7>");
    expect(slack).toContain(
      "1 critical · 0 warning · 2 suggestion · significant concerns · incomplete",
    );
    expect(slack).toContain("<https://ocra.test/reviews/r1|Open in ocra>");
    expect(slack).not.toContain("<!channel>");
    expect(slack).not.toContain("@all");
    expect(slack).not.toContain("](https://evil.test)");
    const wecom = messageOf("wecom", reviewMessage(notice)) as { markdown: { content: string } };
    expect(wecom.markdown.content).toContain("[octo/api#7](https://github.com/octo/api/pull/7)");
    expect(wecom.markdown.content).not.toContain("@all");
    expect(wecom.markdown.content.split("\n")).toHaveLength(4);
  });

  it("goes to the channels set for its kind of review", () => {
    expect(whensFor({ critical: 1, findings: 1 })).toEqual(["blocking", "findings", "every"]);
    expect(whensFor({ critical: 0, findings: 3 })).toEqual(["findings", "every"]);
    expect(whensFor({ critical: 0, findings: 0 })).toEqual(["every"]);
  });
});

describe("the channels", () => {
  it("are added with their address, which is never answered, and removed", async () => {
    const { auth } = await signIn(1, "octo");
    const bad = await add(auth, { kind: "slack", name: "team", when: "every", url: WECOM });
    expect(bad.status).toBe(400);
    const res = await add(auth, { kind: "slack", name: "team", when: "blocking", url: SLACK });
    const { channel } = (await res.json()) as { channel: { id: string } };
    expect(channel).toMatchObject({ kind: "slack", name: "team", when: "blocking", last4: "cret" });
    const listed = await (await call("/api/notifications/channels", { auth })).text();
    expect(listed).not.toContain("XXXXsecret");
    expect(listed).toContain(channel.id);
    const changed = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth,
      json: { when: "every" },
    });
    expect(await changed.json()).toMatchObject({ channel: { when: "every" } });
    const removed = await call(`/api/notifications/channels/${channel.id}`, {
      method: "DELETE",
      auth,
    });
    expect(await removed.json()).toEqual({ removed: true });
  });

  it("are at most ten an account", async () => {
    const { auth } = await signIn(1, "octo");
    for (let i = 0; i < 10; i++) {
      expect(
        (await add(auth, { kind: "slack", name: `c${i}`, when: "every", url: SLACK })).status,
      ).toBe(200);
    }
    expect(
      (await add(auth, { kind: "slack", name: "more", when: "every", url: SLACK })).status,
    ).toBe(400);
  });

  it("are another account's to see only for that account", async () => {
    const a = await signIn(1, "octo");
    const b = await signIn(2, "hubot");
    const res = await add(a.auth, { kind: "slack", name: "team", when: "every", url: SLACK });
    const { channel } = (await res.json()) as { channel: { id: string } };
    const rename = await call(`/api/notifications/channels/${channel.id}`, {
      method: "PATCH",
      auth: b.auth,
      json: { name: "taken" },
    });
    expect(rename.status).toBe(404);
    const theirs = await call("/api/notifications/channels", { auth: b.auth });
    expect(await theirs.json()).toEqual({ channels: [], email: false, slack: false });
    const test = await call(`/api/notifications/channels/${channel.id}/test`, {
      method: "POST",
      auth: b.auth,
    });
    expect(test.status).toBe(404);
  });

  it("are tested with a sample message, and keep whether the chat took it", async () => {
    const { auth } = await signIn(1, "octo");
    const res = await add(auth, { kind: "wecom", name: "群", when: "every", url: WECOM });
    const { channel } = (await res.json()) as { channel: { id: string } };
    const posted = chats(() => Response.json({ errcode: 93000, errmsg: "invalid webhook" }));
    const test = await call(`/api/notifications/channels/${channel.id}/test`, {
      method: "POST",
      auth,
    });
    expect(await test.json()).toEqual({ delivered: false });
    expect(posted[0]?.url).toBe(WECOM);
    expect(posted[0]?.body).toMatchObject({ msgtype: "markdown" });
    const listed = (await (await call("/api/notifications/channels", { auth })).json()) as {
      channels: { lastStatus: string }[];
    };
    expect(listed.channels[0]?.lastStatus).toBe("failed");
  });
});

describe("an uploaded review", () => {
  it("is announced in the channels set for it, and in no other", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await add(web.auth, { kind: "slack", name: "blocking", when: "blocking", url: SLACK });
    await add(web.auth, {
      kind: "slack",
      name: "every",
      when: "every",
      url: "https://hooks.slack.com/services/T000/B000/YYYYevery",
    });
    const posted = chats();
    const clean = {
      ...upload("run-clean", []),
      findings: { critical: 0, warning: 0, suggestion: 0 },
    };
    expect(
      (await call("/api/reviews", { method: "POST", auth: cli.auth, json: clean })).status,
    ).toBe(200);
    expect(posted.map((p) => p.url)).toEqual([
      "https://hooks.slack.com/services/T000/B000/YYYYevery",
    ]);
    posted.length = 0;
    const blocking = upload("run-blocking", []);
    const res = await call("/api/reviews", { method: "POST", auth: cli.auth, json: blocking });
    const { id } = (await res.json()) as { id: string };
    expect(posted.map((p) => p.url).sort()).toEqual(
      [SLACK, "https://hooks.slack.com/services/T000/B000/YYYYevery"].sort(),
    );
    expect(String(posted[0]?.body.text)).toContain(`https://ocra.test/reviews/${id}`);
  });
});
