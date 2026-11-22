import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { changedKeys } from "../src/preferences.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
import { part } from "./parts.js";

const parseSettings = (v: unknown) => part("settings", v);
const parseAgents = (v: unknown) => part("agents", v);
const parseModels = (v: unknown) => part("models", v);

beforeEach(resetDb);

describe("review settings", () => {
  it("accept the data settings within the configuration's bounds", () => {
    const ok = {
      concurrency: 4,
      taskTimeoutMinutes: 10,
      runTimeoutMinutes: 25,
      maxCostUsd: 2.5,
      maxTasks: 60,
      verify: true,
      judge: false,
      fixes: true,
      sampling: { temperature: 0.2, seed: 7 },
      include: ["src/**"],
      exclude: ["**/*.lock", "vendor/**"],
      rules: [{ path: ["services/billing/**"], rule: "Every write carries an idempotency key." }],
      plugins: ["@acme/ocra-rules", "ocra-plugin-x"],
      pluginSettings: { "@acme/ocra-rules": { strict: true } },
    };
    expect(parseSettings(ok)).toEqual(ok);
    expect(parseSettings({ include: [], rules: [], plugins: [] })).toEqual({});
  });

  it("refuse what could move code or keys, and anything out of bounds", () => {
    for (const bad of [
      { providers: { x: { baseUrl: "https://evil.example" } } },
      { extends: "https://evil.example/config.json" },
      { github: { botLogin: "attacker" } },
      { github: { requestChanges: true } },
      { plugins: ["a"], pluginSettings: { "other-plugin": {} } },
      { rules: Array.from({ length: 51 }, () => ({ path: "x", rule: "r" })) },
      { concurrency: 64 },
      { maxCostUsd: -1 },
      { maxTasks: 1.5 },
      { sampling: { temperature: 3 } },
      { exclude: ["a\nb"] },
      { rules: [{ path: "x/**", rule: "" }] },
      { rules: [{ path: "x/**", rule: "r", extra: 1 }] },
      { plugins: ["../../evil"] },
      { plugins: ["https://evil.example/p.tgz"] },
      { pluginSettings: { big: "x".repeat(20_000) } },
      [],
    ]) {
      expect(parseSettings(bad)).toBeUndefined();
    }
  });

  it("are saved on the web, read by the CLI, and each change is audited by key", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const put = (body: unknown) =>
      call("/api/preferences", {
        method: "PUT",
        auth: web.auth,
        json: body,
      });
    expect((await put({ models: { standard: ["ocra-openrouter/m"] } })).status).toBe(200);
    // Saving one part keeps the others.
    expect((await put({ settings: { maxCostUsd: 2, exclude: ["vendor/**"] } })).status).toBe(200);
    const read = (await (await call("/api/preferences", { auth: cli.auth })).json()) as Record<
      string,
      unknown
    >;
    expect(read).toMatchObject({
      models: { standard: ["ocra-openrouter/m"] },
      settings: { maxCostUsd: 2, exclude: ["vendor/**"] },
    });
    expect(read.updatedAt).toBeTruthy();
    expect((await put({ settings: { providers: {} } })).status).toBe(400);

    const events = await scoped(db, web.account.id).list("auditEvents");
    const changes = events.filter((e) => e.kind === "settings.changed").map((e) => e.detail);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: ["models"] }),
        expect.objectContaining({ keys: ["exclude", "maxCostUsd"] }),
      ]),
    );
    expect(JSON.stringify(changes)).not.toContain("vendor");
  });

  it("leave fixes off until the account turns them on, then give the CLI the saved value", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const read = async () =>
      (
        (await (await call("/api/preferences", { auth: cli.auth })).json()) as {
          settings: Record<string, unknown>;
        }
      ).settings;
    expect(await read()).not.toHaveProperty("fixes");
    const put = (settings: unknown) =>
      call("/api/preferences", { method: "PUT", auth: web.auth, json: { settings } });
    expect((await put({ fixes: "yes" })).status).toBe(400);
    expect((await put({ fixes: true, judge: false })).status).toBe(200);
    expect(await read()).toMatchObject({ fixes: true, judge: false });
    expect((await put({ judge: false })).status).toBe(200);
    expect(await read()).not.toHaveProperty("fixes");
  });

  it("list changed keys without values", () => {
    expect(changedKeys({ a: 1, b: [1] }, { a: 1, b: [2], c: true })).toEqual(["b", "c"]);
  });
});

describe("versions", () => {
  it("record each save, list them, and restore one as a new version", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const put = async (body: unknown) =>
      (await (
        await call("/api/preferences", {
          method: "PUT",
          auth: web.auth,
          json: body,
        })
      ).json()) as { version: string };
    const first = await put({ settings: { maxCostUsd: 1 } });
    const second = await put({ settings: { maxCostUsd: 5 } });
    expect(first.version).not.toBe(second.version);
    // Saving the same thing again makes no new version.
    expect((await put({ settings: { maxCostUsd: 5 } })).version).toBe(second.version);

    const list = (await (await call("/api/preferences/versions", { auth: web.auth })).json()) as {
      versions: { id: string; changed: string[] }[];
    };
    expect(list.versions.map((v) => v.id)).toEqual([second.version, first.version]);
    expect((await call("/api/preferences/versions", { auth: cli.auth })).status).toBe(403);

    const restored = await call(`/api/preferences/versions/${first.version}/restore`, {
      method: "POST",
      auth: web.auth,
    });
    const body = (await restored.json()) as { version: string; settings: { maxCostUsd: number } };
    expect(body.settings.maxCostUsd).toBe(1);
    const now = (await (await call("/api/preferences", { auth: cli.auth })).json()) as {
      version: string;
    };
    expect(now.version).toBe(body.version);

    const other = await signIn(2, "other");
    expect(
      (
        await call(`/api/preferences/versions/${first.version}/restore`, {
          method: "POST",
          auth: other.auth,
        })
      ).status,
    ).toBe(404);
  });
});

describe("saving from a stale tab", () => {
  const put = (auth: Record<string, string>, body: unknown) =>
    call("/api/preferences", {
      method: "PUT",
      auth: auth,
      json: body,
    });

  it("is refused when baseVersion is not the current version, and the CLI's save still works", async () => {
    const web = await signIn(1, "octo");
    const first = await put(web.auth, { baseVersion: null, settings: { maxCostUsd: 1 } });
    expect(first.status).toBe(200);
    const v1 = ((await first.json()) as { version: string }).version;
    // Another tab saves on top of v1.
    const second = await put(web.auth, { baseVersion: v1, settings: { maxCostUsd: 5 } });
    expect(second.status).toBe(200);
    const v2 = ((await second.json()) as { version: string }).version;
    // The first tab, still on v1, must not overwrite it.
    const stale = await put(web.auth, { baseVersion: v1, settings: { maxCostUsd: 9 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale", version: v2 });
    const now = (await (await call("/api/preferences", { auth: web.auth })).json()) as {
      version: string;
      settings: { maxCostUsd: number };
    };
    expect(now).toMatchObject({ version: v2, settings: { maxCostUsd: 5 } });
    // A first save against an account that already has versions is stale too.
    expect((await put(web.auth, { baseVersion: null, settings: {} })).status).toBe(409);
    // Without baseVersion the save goes through, as before.
    expect((await put(web.auth, { settings: { maxCostUsd: 7 } })).status).toBe(200);
  });
});

describe("storing the preferences", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the settings, the version and the audit event together or not at all", async () => {
    const web = await signIn(1, "octo");
    const ok = await call("/api/preferences", {
      method: "PUT",
      auth: web.auth,
      json: { settings: { maxCostUsd: 1 } },
    });
    expect(ok.status).toBe(200);
    // The audit event's insert will collide with an existing row, so the
    // last statement of the save fails.
    await scoped(db, web.account.id).insert("auditEvents", { id: "dup", kind: "x", detail: {} });
    vi.spyOn(crypto, "randomUUID").mockReturnValue("dup" as ReturnType<Crypto["randomUUID"]>);
    const failed = await call("/api/preferences", {
      method: "PUT",
      auth: web.auth,
      json: { settings: { maxCostUsd: 9 } },
    });
    vi.restoreAllMocks();
    expect(failed.ok).toBe(false);
    const now = (await (await call("/api/preferences", { auth: web.auth })).json()) as {
      settings: { maxCostUsd: number };
    };
    expect(now.settings.maxCostUsd).toBe(1);
    expect(await scoped(db, web.account.id).list("preferenceVersions")).toHaveLength(1);
  });

  it("keeps the newest 50 versions of the account, and no other account's", async () => {
    const other = await signIn(2, "other");
    await call("/api/preferences", {
      method: "PUT",
      auth: other.auth,
      json: { settings: { maxCostUsd: 1 } },
    });
    const web = await signIn(1, "octo");
    let last = "";
    for (let i = 1; i <= 52; i++) {
      const res = await call("/api/preferences", {
        method: "PUT",
        auth: web.auth,
        json: { settings: { maxTasks: i } },
      });
      last = ((await res.json()) as { version: string }).version;
    }
    const mine = await scoped(db, web.account.id).listSince("preferenceVersions", new Date(0));
    expect(mine).toHaveLength(50);
    expect(mine[0]?.id).toBe(last);
    expect(mine.at(-1)?.snapshot).toMatchObject({ settings: { maxTasks: 3 } });
    expect(await scoped(db, other.account.id).list("preferenceVersions")).toHaveLength(1);
  });
});

describe("per-agent settings", () => {
  it("accept reviewers, roles and tier efforts, and drop empty entries", () => {
    expect(
      parseAgents({
        effort: { standard: "medium", top: "" },
        reviewers: {
          security: { models: ["ocra-openrouter/anthropic/claude-sonnet-5"], effort: "high" },
          docs: { enabled: false },
          performance: {},
        },
        roles: {
          judge: { effort: "high" },
          helper: { models: "ocra-openrouter/qwen/qwen3.8-27b:free" },
        },
      }),
    ).toEqual({
      effort: { standard: "medium" },
      reviewers: {
        security: { models: ["ocra-openrouter/anthropic/claude-sonnet-5"], effort: "high" },
        docs: { enabled: false },
      },
      roles: {
        judge: { effort: "high" },
        helper: { models: ["ocra-openrouter/qwen/qwen3.8-27b:free"] },
      },
    });
  });

  it("refuse unknown levels, models outside ocra Cloud, role names as reviewers and odd ids", () => {
    for (const bad of [
      { effort: { standard: "max" } },
      { reviewers: { security: { models: ["anthropic/claude"] } } },
      { reviewers: { judge: { effort: "low" } } },
      { reviewers: { "Bad Id": {} } },
      { reviewers: { docs: { enabled: "no" } } },
      { roles: { planner: { effort: "low" } } },
      {
        roles: { judge: { models: ["ocra-a/1", "ocra-a/2", "ocra-a/3", "ocra-a/4", "ocra-a/5"] } },
      },
    ]) {
      expect(parseAgents(bad)).toBeUndefined();
    }
  });

  it("refuse models of providers without a chat route, which the CLI cannot use", async () => {
    // ocra-anthropic and ocra-kimi-coding have only Anthropic-style routes.
    for (const model of ["ocra-anthropic/claude-sonnet-5", "ocra-kimi-coding/k2", "ocra-nope/m"]) {
      expect(parseModels({ standard: [model] }), model).toBeUndefined();
      expect(parseAgents({ roles: { judge: { models: [model] } } }), model).toBeUndefined();
      expect(parseAgents({ reviewers: { security: { models: [model] } } }), model).toBeUndefined();
    }
    for (const model of ["ocra-openai/gpt-5.5", "ocra-gemini/gemini-3.5-flash", "ocra-zai/glm"]) {
      expect(parseModels({ standard: [model] }), model).toEqual({ standard: [model] });
    }
    const web = await signIn(1, "octo");
    const put = await call("/api/preferences", {
      method: "PUT",
      auth: web.auth,
      json: { models: { top: ["ocra-anthropic/claude-opus-5"] } },
    });
    expect(put.status).toBe(400);
  });

  it("accept reviewer ids the engine makes: SARIF slugs and plugin reviewers", () => {
    const reviewers = { "2ms": { enabled: false }, "Acme.Style_2": { effort: "low" } };
    expect(parseAgents({ reviewers })).toEqual({ reviewers });
  });

  it("are saved on the web and read by the CLI, with the runtime and tier models", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const body = {
      runtime: "direct",
      models: { standard: ["ocra-openrouter/m"] },
      agents: { reviewers: { security: { effort: "high" } } },
    };
    const put = await call("/api/preferences", {
      method: "PUT",
      auth: web.auth,
      json: body,
    });
    expect(put.status).toBe(200);
    expect(await (await call("/api/preferences", { auth: cli.auth })).json()).toMatchObject(body);
    // The 0.4.0 CLI's endpoint keeps answering with the tier models.
    expect(await (await call("/api/preferences/models", { auth: cli.auth })).json()).toEqual({
      models: { standard: ["ocra-openrouter/m"] },
    });
    const bad = await call("/api/preferences", {
      method: "PUT",
      auth: web.auth,
      json: { ...body, runtime: "docker" },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await call("/api/preferences", {
          method: "PUT",
          auth: cli.auth,
          json: {},
        })
      ).status,
    ).toBe(403);
  });
});
