import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import type { AuditPage } from "../src/shared/index.js";
import { auditLines, lines } from "./audit-lines.js";
import { call, db, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

// The account's audit log as the console reads it: its own events only,
// newest first, paged and filtered, each with its kind's fields only.

beforeEach(resetDb);

type Auth = Record<string, string>;
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXsecret";

const read = async (auth: Auth, query = "") => {
  const res = await call(`/api/audit${query}`, { auth });
  expect(res.status).toBe(200);
  return (await res.json()) as AuditPage;
};
const send = (auth: Auth, method: string, path: string, json?: unknown) =>
  call(path, { method, auth, headers: { origin: ORIGIN }, ...(json ? { json } : {}) });

async function seed(
  accountId: string,
  events: { kind: string; at: number; detail?: object }[],
  prefix = "e",
) {
  const data = scoped(db, accountId);
  for (const [i, e] of events.entries()) {
    await data.insert("auditEvents", {
      id: `${prefix}${String(i).padStart(3, "0")}`,
      kind: e.kind,
      detail: { ...e.detail },
      createdAt: new Date(e.at),
    });
  }
}

describe("the audit log", () => {
  it("lists the account's own events only, newest first", async () => {
    const a = await signIn(1, "a");
    const b = await signIn(2, "b");
    await seed(a.account.id, [
      { kind: "key.deleted", at: 1_000, detail: { provider: "openai" } },
      { kind: "key.saved", at: 2_000, detail: { provider: "anthropic", check: "ok" } },
    ]);
    await seed(
      b.account.id,
      [{ kind: "key.deleted", at: 3_000, detail: { provider: "b-only" } }],
      "b",
    );
    const page = await read(a.auth);
    expect(page).toEqual({
      events: [
        {
          id: "e001",
          kind: "key.saved",
          createdAt: new Date(2_000).toISOString(),
          detail: { provider: "anthropic", check: "ok" },
        },
        {
          id: "e000",
          kind: "key.deleted",
          createdAt: new Date(1_000).toISOString(),
          detail: { provider: "openai" },
        },
      ],
      next: null,
    });
    expect(JSON.stringify(page)).not.toContain("b-only");
  });

  it("answers only each kind's fields, and leaves out kinds it does not know", async () => {
    const a = await signIn(1, "a");
    await seed(a.account.id, [
      {
        kind: "key.saved",
        at: 1_000,
        detail: { provider: "openai", check: "ok", key: "sk-secret", token: { v: "ocra_web_x" } },
      },
      { kind: "key.used", at: 2_000, detail: { model: "m" } },
      { kind: "settings.changed", at: 3_000, detail: { keys: ["runtime", 7], version: 2 } },
    ]);
    const page = await read(a.auth);
    expect(page.events.map((e) => [e.kind, e.detail])).toEqual([
      ["settings.changed", { keys: ["runtime"], version: 2 }],
      ["key.saved", { provider: "openai", check: "ok" }],
    ]);
    expect(JSON.stringify(page)).not.toMatch(/sk-secret|ocra_web_x|key\.used/);
  });

  it("pages through ties at one instant by a cursor, each event once", async () => {
    const a = await signIn(1, "a");
    await seed(
      a.account.id,
      [5_000, 4_000, 4_000, 4_000, 3_000].map((at) => ({ kind: "key.deleted", at })),
    );
    const seen: string[] = [];
    let after = "";
    for (let pages = 0; pages < 5; pages++) {
      const page = await read(a.auth, `?limit=2${after ? `&after=${after}` : ""}`);
      seen.push(...page.events.map((e) => e.id));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toEqual(["e000", "e003", "e002", "e001", "e004"]);
  });

  it("filters by kind and by a time range, since inclusive and until exclusive", async () => {
    const a = await signIn(1, "a");
    await seed(a.account.id, [
      { kind: "key.deleted", at: 1_000 },
      { kind: "key.saved", at: 2_000 },
      { kind: "key.deleted", at: 3_000 },
      { kind: "key.deleted", at: 4_000 },
    ]);
    const ids = async (q: string) => (await read(a.auth, q)).events.map((e) => e.id);
    expect(await ids("?kind=key.deleted")).toEqual(["e003", "e002", "e000"]);
    expect(await ids("?since=2000&until=4000")).toEqual(["e002", "e001"]);
    expect(await ids("?kind=key.deleted&since=2000&until=4000")).toEqual(["e002"]);
  });

  it("refuses an unknown kind, a malformed time or cursor, and a CLI session", async () => {
    const a = await signIn(1, "a");
    for (const q of ["?kind=key.used", "?since=yesterday", "?after=nope"]) {
      const res = await call(`/api/audit${q}`, { auth: a.auth });
      expect(res.status, q).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_body" });
    }
    const cli = await signInCli(1, "a");
    expect((await call("/api/audit", { auth: cli.auth })).status).toBe(403);
  });
});

describe("account changes the log records", () => {
  it("a budget change, with its limit", async () => {
    const a = await signIn(1, "a");
    expect((await send(a.auth, "PUT", "/api/budget", { dailyCalls: 9 })).status).toBe(200);
    expect((await read(a.auth)).events).toMatchObject([
      { kind: "budget.changed", detail: { dailyCalls: 9 } },
    ]);
  });

  it("a rule added, changed and removed, by id and trigger", async () => {
    const a = await signIn(1, "a");
    const rule = {
      name: "label risky",
      trigger: "reviewed",
      conditions: { critical: true },
      actions: [{ kind: "add_labels", labels: ["needs-attention"] }],
    };
    const added = await send(a.auth, "POST", "/api/automations/rules", rule);
    const id = ((await added.json()) as { rule: { id: string } }).rule.id;
    await send(a.auth, "PUT", `/api/automations/rules/${id}`, { ...rule, enabled: false });
    await send(a.auth, "DELETE", `/api/automations/rules/${id}`);
    await send(a.auth, "DELETE", "/api/automations/rules/missing");
    expect(auditLines((await read(a.auth)).events)).toEqual(
      lines(
        ["automation.removed", { rule: id }],
        ["automation.changed", { rule: id, trigger: "reviewed", enabled: false }],
        ["automation.added", { rule: id, trigger: "reviewed" }],
      ),
    );
  });

  it("a channel added, changed and removed, never its address", async () => {
    const a = await signIn(1, "a");
    const added = await send(a.auth, "POST", "/api/notifications/channels", {
      kind: "slack",
      name: "team",
      when: "blocking",
      url: SLACK,
    });
    expect(added.status).toBe(200);
    const id = ((await added.json()) as { channel: { id: string } }).channel.id;
    await send(a.auth, "PATCH", `/api/notifications/channels/${id}`, { when: "every", name: "x" });
    await send(a.auth, "DELETE", `/api/notifications/channels/${id}`);
    const page = await read(a.auth);
    expect(auditLines(page.events)).toEqual(
      lines(
        ["channel.removed", { channel: id }],
        ["channel.changed", { channel: id, keys: ["name", "when"] }],
        ["channel.added", { channel: id, kind: "slack" }],
      ),
    );
    const stored = await scoped(db, a.account.id).find("auditEvents", {});
    expect(JSON.stringify(stored)).not.toMatch(/hooks\.slack|XXXXsecret/);
  });

  it("a session signed out or ended from the list", async () => {
    const a = await signIn(1, "a");
    const other = await signIn(1, "a");
    const listed = (await (await call("/api/sessions", { auth: a.auth })).json()) as {
      sessions: { id: string; current: boolean }[];
    };
    const notMine = listed.sessions.find((s) => !s.current);
    await send(a.auth, "DELETE", `/api/sessions/${notMine?.id}`);
    await send(a.auth, "DELETE", "/api/sessions/missing");
    await send(a.auth, "POST", "/api/auth/logout");
    expect((await call("/api/me", { auth: other.auth })).status).toBe(401);
    const stored = await scoped(db, a.account.id).find("auditEvents", {});
    expect(auditLines(stored)).toEqual(
      lines(["session.revoked", { current: false }], ["session.signed_out", { client: "web" }]),
    );
  });
});
