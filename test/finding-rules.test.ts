import { beforeEach, describe, expect, it } from "vitest";
import { parseFindings } from "../src/findings.js";
import type { FindingInsightsView, FindingRule } from "../src/shared/index.js";
import { finding, upload } from "./finding-uploads.js";
import { call, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

// The rule or learning a finding says it applies (ADR-0080 of the engine):
// stored with the finding, answered on its review and in the inbox, filtered
// by, and grouped in the insights.

beforeEach(resetDb);

const RULE = { kind: "rule", id: "no-raw-sql" } as const;
const LEARNING = { kind: "learning", id: "retry-on-409" } as const;

async function sharing(id: number, login: string) {
  const web = await signIn(id, login);
  const cli = await signInCli(id, login);
  await call("/api/account/sharing", {
    method: "PUT",
    auth: web.auth,
    headers: { origin: ORIGIN },
    json: { enabled: true },
  });
  const post = async (body: unknown) =>
    (await (await call("/api/reviews", { method: "POST", auth: cli.auth, json: body })).json()) as {
      id: string;
    };
  const get = async <T>(path: string) => (await (await call(path, { auth: web.auth })).json()) as T;
  return { web, post, get };
}

type Listed = { findings: { title: string; rule: FindingRule }[] };

describe("a finding's rule", () => {
  it("is kept when the upload names a valid one, and read as none when it is malformed", () => {
    const { rows } = parseFindings([
      finding({ rule: RULE }),
      finding({ rule: LEARNING }),
      finding({ rule: { kind: "policy", id: "x" } }),
      finding({ rule: { kind: "rule", id: "Has Spaces" } }),
      finding({ rule: { kind: "rule", id: `a${"b".repeat(80)}` } }),
      finding(),
    ]);
    expect(rows.map((r) => [r.ruleKind, r.ruleId])).toEqual([
      ["rule", "no-raw-sql"],
      ["learning", "retry-on-409"],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("is answered on the review, in the inbox and in the export, null where none was named", async () => {
    const a = await sharing(1, "octo");
    const { id } = await a.post(
      upload("r1", [
        finding({ fingerprint: "fp-r", title: "ruled", rule: RULE }),
        finding({ fingerprint: "fp-n", title: "plain" }),
      ]),
    );
    const detail = await a.get<{ findings: { title: string; rule: FindingRule }[] }>(
      `/api/reviews/${id}`,
    );
    expect(detail.findings.map((f) => [f.title, f.rule])).toEqual([
      ["ruled", RULE],
      ["plain", null],
    ]);
    const listed = await a.get<Listed>("/api/findings");
    expect(new Map(listed.findings.map((f) => [f.title, f.rule]))).toEqual(
      new Map([
        ["ruled", RULE],
        ["plain", null],
      ]),
    );
    const exported = await a.get<{ findings: Record<string, unknown>[] }>(
      `/api/reviews/${id}/export`,
    );
    expect(exported.findings[0]?.rule).toEqual(RULE);
    expect(exported.findings[1]).not.toHaveProperty("rule");
  });

  it("filters the inbox by rule, by learning and by none named, and refuses a malformed one", async () => {
    const a = await sharing(1, "octo");
    await a.post(
      upload("r1", [
        finding({ fingerprint: "fp-r", title: "ruled", rule: RULE }),
        finding({ fingerprint: "fp-l", title: "learned", rule: LEARNING }),
        finding({ fingerprint: "fp-n", title: "plain" }),
      ]),
    );
    const titles = async (rule: string) =>
      (await a.get<Listed>(`/api/findings?rule=${encodeURIComponent(rule)}`)).findings.map(
        (f) => f.title,
      );
    expect(await titles("rule:no-raw-sql")).toEqual(["ruled"]);
    expect(await titles("learning:retry-on-409")).toEqual(["learned"]);
    expect(await titles("learning:no-raw-sql")).toEqual([]);
    expect(await titles("none")).toEqual(["plain"]);
    for (const bad of ["policy:x", "rule:", "rule:Bad Id", "no-raw-sql"]) {
      const res = await call(`/api/findings?rule=${encodeURIComponent(bad)}`, {
        auth: a.web.auth,
      });
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("insights by rule", () => {
  it("splits rules from learnings, groups the findings that named none, and counts only the account's", async () => {
    const a = await sharing(1, "octo");
    const b = await sharing(2, "other");
    await a.post(
      upload("r1", [
        finding({ fingerprint: "fp-1", rule: RULE }),
        finding({ fingerprint: "fp-2", rule: RULE }),
        finding({ fingerprint: "fp-3", rule: { kind: "learning", id: "no-raw-sql" } }),
        finding({ fingerprint: "fp-4" }),
      ]),
    );
    // The same finding on a second review is a second row, as everywhere in the insights.
    await a.post(upload("r2", [finding({ fingerprint: "fp-1", rule: RULE })]));
    await b.post(upload("r1", [finding({ fingerprint: "fp-9", rule: LEARNING })]));

    const got = await a.get<FindingInsightsView>("/api/findings/insights");
    expect(got.byRule.map((r) => [r.key, r.rule, r.label, r.total])).toEqual([
      ["rule:no-raw-sql", RULE, "no-raw-sql", 3],
      ["learning:no-raw-sql", { kind: "learning", id: "no-raw-sql" }, "no-raw-sql", 1],
      [null, null, null, 1],
    ]);
    expect(got.otherRules).toBeNull();
    const theirs = await b.get<FindingInsightsView>("/api/findings/insights");
    expect(theirs.byRule.map((r) => [r.key, r.total])).toEqual([["learning:retry-on-409", 1]]);
  });

  it("keeps the first rules by findings and sums the rest", async () => {
    const a = await sharing(1, "octo");
    const list = Array.from({ length: 23 }, (_, i) =>
      finding({
        fingerprint: `fp-${i}`,
        rule: { kind: "rule", id: `r-${String(i).padStart(2, "0")}` },
      }),
    );
    // r-00 has three findings, the others one each.
    list.push(
      finding({ fingerprint: "fp-x", rule: { kind: "rule", id: "r-00" } }),
      finding({ fingerprint: "fp-y", rule: { kind: "rule", id: "r-00" } }),
    );
    await a.post(upload("r1", list));
    const got = await a.get<FindingInsightsView>("/api/findings/insights");
    expect(got.byRule).toHaveLength(20);
    expect(got.byRule[0]).toMatchObject({ key: "rule:r-00", total: 3 });
    expect(got.byRule.at(-1)?.key).toBe("rule:r-19");
    expect(got.otherRules).toMatchObject({ rules: 3, total: 3, open: 3, acceptanceRate: null });
  });
});
