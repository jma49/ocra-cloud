import { beforeEach, describe, expect, it } from "vitest";
import { finding, HASH, upload } from "./finding-uploads.js";
import { call, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);

type Listed = {
  findings: {
    id: string;
    title: string;
    repoHash: string;
    status: string;
    reason: string | null;
    note: string | null;
  }[];
  next: string | null;
  statuses: Record<string, number>;
};

/** A signed-in account that shares findings, with the CLI's and the web's sessions. */
async function sharing(id = 1, login = "octo") {
  const web = await signIn(id, login);
  const cli = await signInCli(id, login);
  await call("/api/account/sharing", {
    method: "PUT",
    auth: web.auth,
    headers: { origin: ORIGIN },
    json: { enabled: true },
  });
  const post = (body: unknown) =>
    call("/api/reviews", { method: "POST", auth: cli.auth, json: body });
  const list = async (query = "") =>
    (await (await call(`/api/findings${query}`, { auth: web.auth })).json()) as Listed;
  const decide = (json: unknown) =>
    call("/api/findings/decide", {
      method: "POST",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json,
    });
  return { web, cli, post, list, decide };
}

describe("the findings inbox", () => {
  it("lists every review's findings newest first, filters them and pages through them", async () => {
    const a = await sharing();
    await a.post(upload("r1", [finding({ fingerprint: "fp-a1", title: "first" })]));
    await a.post({
      ...upload("r2", [
        finding({ fingerprint: "fp-b1", title: "second", severity: "warning" }),
        finding({ fingerprint: "fp-b2", title: "third", verification: null }),
      ]),
      repoHash: "c".repeat(64),
    });

    const all = await a.list();
    expect(all.findings.map((f) => f.title).sort()).toEqual(["first", "second", "third"]);
    expect(all.statuses).toEqual({ open: 3, fixed: 0, dismissed: 0 });
    expect(all.next).toBeNull();

    expect((await a.list(`?repo=${HASH}`)).findings.map((f) => f.title)).toEqual(["first"]);
    expect((await a.list("?severity=warning")).findings.map((f) => f.title)).toEqual(["second"]);
    expect((await a.list("?verification=none")).findings.map((f) => f.title)).toEqual(["third"]);

    const first = await a.list("?limit=2");
    expect(first.findings).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await a.list(`?limit=2&after=${first.next}`);
    expect(second.findings).toHaveLength(1);
    expect(second.next).toBeNull();
    const seen = [...first.findings, ...second.findings].map((f) => f.id);
    expect(new Set(seen).size).toBe(3);

    const bad = await call("/api/findings?status=gone", { auth: a.web.auth });
    expect(bad.status).toBe(400);
  });

  it("records fixed and dismissed with a reason, reopens, and never touches another account's", async () => {
    const a = await sharing();
    await a.post(
      upload("r1", [finding({ fingerprint: "fp-1" }), finding({ fingerprint: "fp-2" })]),
    );
    const [one, two] = (await a.list()).findings;
    if (!one || !two) throw new Error("two findings expected");

    expect((await a.decide({ ids: [one.id], status: "dismissed" })).status).toBe(400);
    expect((await a.decide({ ids: [one.id], status: "fixed", reason: "wrong_fix" })).status).toBe(
      400,
    );

    const dismissed = await a.decide({
      ids: [one.id],
      status: "dismissed",
      reason: "false_positive",
      note: "the input is a constant",
    });
    expect(await dismissed.json()).toEqual({ changed: 1, remembered: 0 });
    await a.decide({ ids: [two.id], status: "fixed" });
    const after = await a.list();
    expect(after.statuses).toEqual({ open: 0, fixed: 1, dismissed: 1 });
    expect(after.findings.find((f) => f.id === one.id)).toMatchObject({
      status: "dismissed",
      reason: "false_positive",
      note: "the input is a constant",
    });
    expect((await a.list("?status=fixed")).findings.map((f) => f.id)).toEqual([two.id]);

    await a.decide({ ids: [one.id], status: "open" });
    expect((await a.list()).findings.find((f) => f.id === one.id)).toMatchObject({
      status: "open",
      reason: null,
      note: null,
    });

    const b = await sharing(2, "other");
    expect((await b.decide({ ids: [two.id], status: "open" })).status).toBe(404);
    expect((await b.list()).findings).toEqual([]);
    expect((await a.list("?status=fixed")).findings.map((f) => f.id)).toEqual([two.id]);
  });

  it("remembers dismissed findings once per repository fingerprint", async () => {
    const a = await sharing();
    await a.post(upload("r1", [finding({ fingerprint: "fp-1" })]));
    await a.post(
      upload("r2", [finding({ fingerprint: "fp-1" }), finding({ fingerprint: "fp-2" })]),
    );
    const ids = (await a.list()).findings.map((f) => f.id);

    expect((await a.decide({ ids, status: "fixed", remember: true })).status).toBe(400);
    const answer = await a.decide({
      ids,
      status: "dismissed",
      reason: "already_known",
      remember: true,
    });
    expect(await answer.json()).toEqual({ changed: 3, remembered: 2 });
    const again = await a.decide({
      ids,
      status: "dismissed",
      reason: "already_known",
      remember: true,
    });
    expect(await again.json()).toEqual({ changed: 3, remembered: 0 });

    const memory = (await (
      await call(`/api/memory?repo=${HASH}`, { auth: a.cli.auth })
    ).json()) as {
      entries: { fingerprint: string; reason: string }[];
    };
    expect(memory.entries.map((m) => m.fingerprint).sort()).toEqual(["fp-1", "fp-2"]);
    expect(memory.entries[0]?.reason).toBe("already_known");
  });

  it("is the web's: the CLI can neither list nor decide", async () => {
    const a = await sharing();
    expect((await call("/api/findings", { auth: a.cli.auth })).status).toBe(403);
    expect(
      (
        await call("/api/findings/decide", {
          method: "POST",
          auth: a.cli.auth,
          json: { ids: ["x"], status: "open" },
        })
      ).status,
    ).toBe(403);
  });
});

describe("finding insights", () => {
  it("counts the decisions per reviewer, severity and reason, with an acceptance rate", async () => {
    const a = await sharing();
    await a.post(
      upload("r1", [
        finding({ fingerprint: "fp-1", reviewer: "security", severity: "critical" }),
        finding({ fingerprint: "fp-2", reviewer: "security", severity: "warning" }),
        finding({ fingerprint: "fp-3", reviewer: "correctness", severity: "warning" }),
      ]),
    );
    const listed = (await a.list()).findings;
    const [x, y, z] = listed;
    if (!x || !y || !z) throw new Error("three findings expected");
    await a.decide({ ids: [x.id], status: "fixed" });
    await a.decide({ ids: [y.id], status: "dismissed", reason: "false_positive" });

    const got = (await (await call("/api/findings/insights", { auth: a.web.auth })).json()) as {
      total: { total: number; fixed: number; dismissed: number; acceptanceRate: number | null };
      byReviewer: { key: string; total: number }[];
      dismissReasons: { key: string; n: number }[];
    };
    expect(got.total).toMatchObject({ total: 3, fixed: 1, dismissed: 1, acceptanceRate: 0.5 });
    expect(got.byReviewer.map((r) => [r.key, r.total]).sort()).toEqual([
      ["correctness", 1],
      ["security", 2],
    ]);
    expect(got.dismissReasons).toEqual([{ key: "false_positive", n: 1 }]);
  });
});
