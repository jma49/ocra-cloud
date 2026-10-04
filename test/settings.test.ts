import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { changedKeys, parseSettings } from "../src/settings.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);
const json = { "content-type": "application/json" };

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
        headers: { ...web.auth, ...json },
        body: JSON.stringify(body),
      });
    expect((await put({ models: { standard: ["ocra-openrouter/m"] } })).status).toBe(200);
    // Saving one part keeps the others.
    expect((await put({ settings: { maxCostUsd: 2, exclude: ["vendor/**"] } })).status).toBe(200);
    const read = (await (await call("/api/preferences", { headers: cli.auth })).json()) as Record<
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
          headers: { ...web.auth, ...json },
          body: JSON.stringify(body),
        })
      ).json()) as { version: string };
    const first = await put({ settings: { maxCostUsd: 1 } });
    const second = await put({ settings: { maxCostUsd: 5 } });
    expect(first.version).not.toBe(second.version);
    // Saving the same thing again makes no new version.
    expect((await put({ settings: { maxCostUsd: 5 } })).version).toBe(second.version);

    const list = (await (
      await call("/api/preferences/versions", { headers: web.auth })
    ).json()) as {
      versions: { id: string; changed: string[] }[];
    };
    expect(list.versions.map((v) => v.id)).toEqual([second.version, first.version]);
    expect((await call("/api/preferences/versions", { headers: cli.auth })).status).toBe(403);

    const restored = await call(`/api/preferences/versions/${first.version}/restore`, {
      method: "POST",
      headers: web.auth,
    });
    const body = (await restored.json()) as { version: string; settings: { maxCostUsd: number } };
    expect(body.settings.maxCostUsd).toBe(1);
    const now = (await (await call("/api/preferences", { headers: cli.auth })).json()) as {
      version: string;
    };
    expect(now.version).toBe(body.version);

    const other = await signIn(2, "other");
    expect(
      (
        await call(`/api/preferences/versions/${first.version}/restore`, {
          method: "POST",
          headers: other.auth,
        })
      ).status,
    ).toBe(404);
  });
});
