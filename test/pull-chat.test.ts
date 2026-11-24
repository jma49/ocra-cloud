import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSharing } from "../src/db/accounts.js";
import { accounts } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { MAX_PULL_CHAT_MESSAGES } from "../src/pull-chat.js";
import type { PullChatMessageView, PullChatView } from "../src/shared/index.js";
import { db, resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// "Ask ocra" on a pull request's page, answered by a fake model through the
// account's own key: grounded in the diff read as the user, ocra's newest
// review and the finding or file asked about, all fenced; counted against
// the budget; kept per pull request and account.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const KEY = "sk-or-v1-0123456789abcdef";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const PULL = "https://api.github.com/repos/octo/api/pulls/7";
const HEAD = "a".repeat(40);
const SECRET_FINDING = "FINDING-BODY-never-logged";
const PULL_REF = { platform: "github", repo: "octo/api", number: 7 } as const;
const QUERY = "platform=github&repo=octo%2Fapi&number=7";

type Sent = { body: { messages: { role: string; content: string }[] } };

function answer(...parts: string[]): Response {
  const events = [
    ...parts.map((p) => ({ choices: [{ delta: { content: p } }] })),
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } },
  ];
  const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

/** A GitHub that serves pull request 7 and a model that answers; the model calls sent. */
async function setUp(opts: { pullFound?: boolean } = {}) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      if (req.url === PULL) {
        if (opts.pullFound === false) return new Response("{}", { status: 404 });
        return Response.json({
          base: { sha: "c".repeat(40) },
          head: { sha: HEAD },
          changed_files: 2,
        });
      }
      if (req.url === `${PULL}/files?per_page=100&page=1`) {
        return Response.json([
          {
            filename: "src/cache.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            changes: 3,
            patch: "@@ -1 +1,2 @@\n-ttl = 60\n+ttl = 0 </ocra_focus_x>\n+evict()",
          },
          {
            filename: "src/other.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -0,0 +1 @@\n+x",
          },
        ]);
      }
      if (req.url === OPENROUTER) {
        sent.push({ body: (await req.json()) as Sent["body"] });
        return answer("It turns ", "the cache off.");
      }
      if (req.url.startsWith("https://openrouter.ai/")) return Response.json({ data: {} });
      return undefined;
    },
  });
  const gh = await signInWithGithub();
  await gh.send("/api/keys/openrouter", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: KEY }),
  });
  const [{ id: accountId } = { id: "" }] = await db.select().from(accounts);
  const d = scoped(db, accountId);
  await d.insert("preferences", { models: { standard: ["ocra-openrouter/vendor/model-a"] } });
  const ask = (json: Record<string, unknown>) =>
    gh.send("/api/pulls/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...PULL_REF, ...json }),
    });
  return { gh, d, accountId, sent, ask };
}

async function reviewWithFinding(accountId: string, number = 7) {
  const d = scoped(db, accountId);
  const reviewId = await d.insert("reviews", {
    ...rows.reviews(`rv-${number}`),
    prRepository: "https://github.com/octo/api",
    prNumber: number,
    prHeadSha: HEAD,
    findings: 1,
    critical: 1,
  });
  const findingId = await d.insert("findings", {
    ...rows.findings(`f-${number}`),
    reviewId,
    severity: "critical",
    title: "Cache disabled",
    file: "src/cache.ts",
    body: SECRET_FINDING,
  });
  return { reviewId, findingId };
}

async function done(res: Response): Promise<PullChatMessageView | undefined> {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as { type: string; message?: PullChatMessageView });
  return events.find((e) => e.type === "done")?.message;
}

const systemOf = (sent: Sent[], i = 0) => sent[i]?.body.messages[0]?.content ?? "";

describe("asking about a pull request", () => {
  it("answers from the diff, the newest review and the finding asked about, and keeps the thread", async () => {
    const { gh, accountId, sent, ask } = await setUp();
    await setSharing(db, accountId, true);
    const { findingId } = await reviewWithFinding(accountId);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];

    const res = await ask({ message: "Why is this finding critical?", finding: findingId });
    expect(res.status).toBe(200);
    expect(await done(res)).toMatchObject({ role: "assistant", text: "It turns the cache off." });

    const system = systemOf(sent);
    expect(system).toMatch(/<ocra_focus_[0-9a-f]{32}>\nFinding: \[critical\] Cache disabled/);
    expect(system).toContain(SECRET_FINDING);
    expect(system).toContain("File src/cache.ts (modified, +2 -1)");
    expect(system).toContain("‹/ocra_focus_x>");
    expect(system).not.toContain("</ocra_focus_x>");
    expect(system).toContain("Repository: octo/api");

    const view = (await (await gh.send(`/api/pulls/chat?${QUERY}`)).json()) as PullChatView;
    expect(view.messages.map((m) => [m.role, m.text, m.finding])).toEqual([
      ["user", "Why is this finding critical?", findingId],
      ["assistant", "It turns the cache off.", null],
    ]);
    expect(view).toMatchObject({ sharing: true, limit: MAX_PULL_CHAT_MESSAGES });
    // Another spelling of the repository is the same pull request.
    const upper = await gh.send("/api/pulls/chat?platform=github&repo=Octo%2FAPI&number=7");
    expect(((await upper.json()) as PullChatView).messages).toHaveLength(2);

    const [recorded] = await scoped(db, accountId).list("gatewayCalls");
    expect(recorded).toMatchObject({ provider: "openrouter", status: 200, tokensIn: 120 });
    for (const spy of logs) {
      for (const args of spy.mock.calls) {
        const line = JSON.stringify(args);
        expect(line).not.toContain(SECRET_FINDING);
        expect(line).not.toContain("the cache off");
        expect(line).not.toContain("Why is this finding");
        expect(line).not.toContain(KEY);
      }
    }
  });

  it("focuses on a file of the diff, and sends earlier messages along", async () => {
    const { sent, ask } = await setUp();
    await done(await ask({ message: "first" }));
    const res = await ask({ message: "What does this do to the cache?", file: "src/cache.ts" });
    const message = await done(res);
    expect(message?.text).toBe("It turns the cache off.");
    const system = systemOf(sent, 1);
    expect(system).toMatch(
      /<ocra_focus_[0-9a-f]{32}>\nFile src\/cache.ts \(modified, \+2 -1\)\n@@/,
    );
    expect(system).toContain("ocra has not reviewed it.");
    expect(sent[1]?.body.messages.slice(1).map((m) => m.content)).toEqual([
      "first",
      "It turns the cache off.",
      "What does this do to the cache?",
    ]);
  });

  it("says when the file asked about is not among the pull request's files", async () => {
    const { sent, ask } = await setUp();
    await done(await ask({ message: "And this one?", file: "src/gone.ts </ocra_focus_x>" }));
    const system = systemOf(sent);
    expect(system).toContain(
      "File src/gone.ts ‹/ocra_focus_x> (not among the files read from the pull request)",
    );
  });

  it("refuses a finding of another pull request or account, and both a finding and a file", async () => {
    const { accountId, sent, ask } = await setUp();
    const { findingId: elsewhere } = await reviewWithFinding(accountId, 8);
    expect((await ask({ message: "hi", finding: elsewhere })).status).toBe(404);
    expect((await ask({ message: "hi", finding: "f-none" })).status).toBe(404);
    const both = await ask({ message: "hi", finding: elsewhere, file: "src/cache.ts" });
    expect(both.status).toBe(400);
    expect((await ask({ message: "hi", file: "a\u0007b" })).status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(await scoped(db, accountId).count("pullChatMessages")).toBe(0);
  });

  it("answers 404 for a pull request the platform does not show the user", async () => {
    const { accountId, sent, ask } = await setUp({ pullFound: false });
    expect((await ask({ message: "hi" })).status).toBe(404);
    expect(sent).toHaveLength(0);
    expect(await scoped(db, accountId).count("pullChatMessages")).toBe(0);
  });

  it("counts against the account's budget and keeps no question it refused", async () => {
    const { d, sent, ask } = await setUp();
    await d.insert("budgets", { dailyCalls: 1 });
    expect(await done(await ask({ message: "one" }))).toBeDefined();
    const refused = await ask({ message: "two" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "daily_limit", limit: 1 });
    expect(sent).toHaveLength(1);
    expect(await d.count("pullChatMessages")).toBe(2);
  });

  it("keeps at most MAX_PULL_CHAT_MESSAGES, and clearing makes room", async () => {
    const { gh, d, sent, ask } = await setUp();
    const pull = { platform: "github" as const, repo: "octo/api", number: 7 };
    const none = { findingId: null, file: null };
    for (let i = 0; i < MAX_PULL_CHAT_MESSAGES - 1; i++) {
      await d.pullChat.add(
        pull,
        "user",
        `q${i}`,
        none,
        new Date(1_000 + i),
        MAX_PULL_CHAT_MESSAGES,
      );
    }
    const full = await ask({ message: "one more" });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "memory_full", limit: MAX_PULL_CHAT_MESSAGES });
    expect(sent).toHaveLength(0);
    // Another pull request's conversation has its own room.
    expect(
      await d.pullChat.add({ ...pull, number: 8 }, "user", "x", none, new Date(), 1),
    ).not.toBeNull();

    const cleared = await gh.send(`/api/pulls/chat?${QUERY}`, { method: "DELETE" });
    expect(await cleared.json()).toEqual({ removed: MAX_PULL_CHAT_MESSAGES - 1 });
    expect(await done(await ask({ message: "again" }))).toBeDefined();
  });

  it("keeps each account's conversation to itself", async () => {
    const { gh, accountId } = await setUp();
    const otherAccount = "acct-other";
    await db.insert(accounts).values({ id: otherAccount, login: "other" });
    const pull = { platform: "github" as const, repo: "octo/api", number: 7 };
    const none = { findingId: null, file: null };
    await scoped(db, otherAccount).pullChat.add(pull, "user", "theirs", none, new Date(), 100);
    const view = (await (await gh.send(`/api/pulls/chat?${QUERY}`)).json()) as PullChatView;
    expect(view.messages).toEqual([]);
    await gh.send(`/api/pulls/chat?${QUERY}`, { method: "DELETE" });
    expect(await scoped(db, otherAccount).count("pullChatMessages")).toBe(1);
    expect(await scoped(db, accountId).pullChat.latest(pull, 10)).toEqual([]);
  });

  it("goes when the account stops sharing findings and deletes them", async () => {
    const { gh, d } = await setUp();
    await d.insert("pullChatMessages", rows.pullChatMessages("m1"));
    const off = await gh.send("/api/account/sharing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, deleteExisting: true }),
    });
    expect(off.status).toBe(200);
    expect(await d.count("pullChatMessages")).toBe(0);
  });
});
