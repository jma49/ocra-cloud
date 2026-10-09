import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { call, db, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

// Audit D-hyg: parallel requests must not leave two keys, fail a first
// save with a 500, or pass the memory cap together.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const origin = { origin: ORIGIN };
const HASH = "d".repeat(64);

describe("parallel writes", () => {
  it("leave one key per provider, the last one saved", async () => {
    const me = await signIn(1, "me");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const save = (key: string) =>
      call("/api/keys/openai", {
        method: "PUT",
        auth: me.auth,
        headers: origin,
        json: { key },
      });
    const answers = await Promise.all(
      ["sk-first-1111", "sk-second-2222", "sk-third-3333"].map(save),
    );
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    const rows = await scoped(db, me.account.id).list("providerKeys");
    expect(rows).toHaveLength(1);
    // A later save replaces the key in place.
    await save("sk-fourth-4444");
    expect((await scoped(db, me.account.id).list("providerKeys")).map((r) => r.last4)).toEqual([
      "4444",
    ]);
  });

  it("let two first saves of the preferences both succeed", async () => {
    const me = await signIn(1, "me");
    const save = (runtime: string) =>
      call("/api/preferences", {
        method: "PUT",
        auth: me.auth,
        headers: origin,
        json: { runtime },
      });
    const answers = await Promise.all([save("direct"), save("opencode")]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(await scoped(db, me.account.id).list("preferences")).toHaveLength(1);
  });

  it("let only one of two saves from the same version of the preferences land", async () => {
    const me = await signIn(1, "me");
    const save = (body: unknown) =>
      call("/api/preferences", { method: "PUT", auth: me.auth, headers: origin, json: body });
    const v1 = (
      (await (await save({ baseVersion: null, settings: { maxCostUsd: 1 } })).json()) as {
        version: string;
      }
    ).version;
    // Two tabs, both opened on v1, save at once: the second must not
    // silently overwrite the first.
    const answers = await Promise.all([
      save({ baseVersion: v1, settings: { maxCostUsd: 5 } }),
      save({ baseVersion: v1, settings: { maxCostUsd: 9 } }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const [won] = answers.filter((r) => r.status === 200);
    const saved = (await won?.json()) as { version: string; settings: unknown };
    const now = (await (await call("/api/preferences", { auth: me.auth })).json()) as {
      version: string;
      settings: unknown;
    };
    expect(now).toMatchObject({ version: saved.version, settings: saved.settings });
    expect(await scoped(db, me.account.id).count("preferenceVersions")).toBe(2);
    expect(await scoped(db, me.account.id).count("auditEvents", { kind: "settings.changed" })).toBe(
      2,
    );
  });

  it("stop at the memory cap and keep one entry per finding", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: origin,
      json: { enabled: true },
    });
    const finding = (fingerprint: string) => ({
      fingerprint,
      reviewer: "security",
      severity: "warning",
      file: "src/a.ts",
      title: `t ${fingerprint}`,
      body: "b",
    });
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        auth: cli.auth,
        headers: origin,
        json: {
          runId: "r",
          repoHash: HASH,
          source: "local",
          findings: { critical: 0, warning: 3, suggestion: 0 },
          findingList: ["fp-a", "fp-b", "fp-c"].map(finding),
        },
      })
    ).json()) as { id: string };
    const detail = (await (await call(`/api/reviews/${posted.id}`, { auth: web.auth })).json()) as {
      findings: { id: string; fingerprint: string }[];
    };
    const idOf = (fp: string) => detail.findings.find((f) => f.fingerprint === fp)?.id;
    const remember = (fp: string) =>
      call("/api/memory", {
        method: "POST",
        auth: web.auth,
        headers: origin,
        json: { findingId: idOf(fp), reason: "accepted" },
      });
    const data = scoped(db, web.account.id);

    // The same finding twice at once: one entry.
    const same = await Promise.all([remember("fp-c"), remember("fp-c")]);
    expect(same.map((r) => r.status)).toEqual([200, 200]);
    expect(await data.count("accountMemory")).toBe(1);

    // 499 entries: two different findings at once, only one fits.
    await data.batch((w) =>
      Array.from({ length: 498 }, (_, i) =>
        w.insert("accountMemory", {
          id: `m${i}`,
          repoHash: HASH,
          fingerprint: `old-${i}`,
          reason: "r",
        }),
      ),
    );
    const answers = await Promise.all([remember("fp-a"), remember("fp-b")]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await data.count("accountMemory")).toBe(500);
  });
});

describe("the legacy models endpoint", () => {
  it("is read-only: saving goes through the versioned preferences", async () => {
    const me = await signIn(1, "me");
    const put = await call("/api/preferences/models", {
      method: "PUT",
      auth: me.auth,
      headers: origin,
      json: { standard: ["ocra-openrouter/m"] },
    });
    expect(put.status).toBe(404);
    expect(await scoped(db, me.account.id).list("preferences")).toEqual([]);
  });
});
