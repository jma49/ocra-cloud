import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { finding, HASH, upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";
import { rows } from "./table-rows.js";

beforeEach(resetDb);

describe("account memory", () => {
  it("remembers a finding once per repository, lists it for the CLI, and deletes it", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        auth: cli.auth,
        json: upload("r", [finding()]),
      })
    ).json()) as { id: string };
    const detail = (await (await call(`/api/reviews/${posted.id}`, { auth: web.auth })).json()) as {
      findings: { id: string }[];
    };
    const findingId = detail.findings[0]?.id;
    const remember = (reason: string) =>
      call("/api/memory", {
        method: "POST",
        auth: web.auth,
        headers: { origin: "https://ocra.test" },
        json: { findingId, reason },
      });
    expect((await remember("")).status).toBe(400);
    const first = (await (await remember("Accepted: internal tool")).json()) as { id: string };
    expect(await (await remember("again")).json()).toEqual({ id: first.id, duplicate: true });

    const list = (await (await call(`/api/memory?repo=${HASH}`, { auth: cli.auth })).json()) as {
      entries: { fingerprint: string; reason: string }[];
    };
    expect(list.entries).toMatchObject([
      { fingerprint: "fp-1234", reason: "Accepted: internal tool" },
    ]);
    expect(
      (await call(`/api/memory?repo=${"c".repeat(64)}`, { auth: cli.auth }).then((r) =>
        r.json(),
      )) as unknown,
    ).toEqual({ entries: [], total: 0 });
    // The CLI reads memory; only the web changes it.
    expect((await call("/api/memory", { method: "POST", auth: cli.auth, json: {} })).status).toBe(
      403,
    );

    await call(`/api/memory/${first.id}`, {
      method: "DELETE",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
    });
    expect(
      ((await (await call("/api/memory", { auth: web.auth })).json()) as { entries: unknown[] })
        .entries,
    ).toEqual([]);
  });
});

describe("listing account memory (#96)", () => {
  type Listed = { entries: { id: string; repoHash: string }[]; total: number };

  /** `n` entries of the repository, the higher the index the newer, ten rows a statement. */
  async function remembered(accountId: string, repoHash: string, n: number, start: number) {
    const entries = Array.from({ length: n }, (_, i) => ({
      ...rows.accountMemory(`${repoHash.slice(0, 1)}${i}`),
      accountId,
      repoHash,
      createdAt: new Date(start + i * 1000),
    }));
    for (let i = 0; i < entries.length; i += 10) {
      await db.insert(schema.accountMemory).values(entries.slice(i, i + 10));
    }
  }

  it("answers at most 500 entries, the newest, and counts them all", async () => {
    const cli = await signInCli(1, "octo");
    const other = "d".repeat(64);
    const start = Date.now() - 10_000_000;
    await remembered(cli.account.id, HASH, 500, start);
    await remembered(cli.account.id, other, 20, start + 1_000_000);
    const list = async (query: string) =>
      (await (await call(`/api/memory${query}`, { auth: cli.auth })).json()) as Listed;

    const all = await list("");
    expect(all.entries).toHaveLength(500);
    expect(all.total).toBe(520);
    expect(all.entries.slice(0, 2).map((e) => e.id)).toEqual(["d19", "d18"]);
    expect(all.entries.at(-1)?.id).toBe("b20");

    const one = await list("?limit=1");
    expect(one.entries.map((e) => e.id)).toEqual(["d19"]);
    expect(one.total).toBe(520);

    const repo = await list(`?repo=${HASH}&limit=2`);
    expect(repo.entries.map((e) => e.id)).toEqual(["b499", "b498"]);
    expect(repo.total).toBe(500);

    // A limit past the bound, below 1 or not a number keeps to 1..500.
    expect((await list("?limit=100000")).entries).toHaveLength(500);
    expect((await list("?limit=-3")).entries).toHaveLength(1);
    expect((await list("?limit=many")).entries).toHaveLength(500);
  });
});
