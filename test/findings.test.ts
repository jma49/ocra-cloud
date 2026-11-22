import { MAX_FIELD, redact, redactField } from "@open-cr-agent/cloud-contract";
import vectors from "@open-cr-agent/cloud-contract/fixtures/redaction-vectors.json";
import { beforeEach, describe, expect, it } from "vitest";
import { parseFindings } from "../src/findings.js";
import { finding, upload } from "./finding-uploads.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);

describe("redaction", () => {
  // The contract's own vectors, which the CLI's pass runs too (#25).
  it("redacts every shared secret vector and leaves the plain lines alone", () => {
    for (const v of vectors.redact) {
      const r = redact(v.line);
      expect(r.redacted, v.line).toBe(true);
      expect(r.text, v.line).not.toContain(v.secret);
    }
    for (const line of vectors.keep)
      expect(redact(line), line).toEqual({ text: line, redacted: false });
  });

  it("redacts a finding's file and category too", () => {
    const [row] = parseFindings([
      finding({
        file: "config/ghp_abcdefghijklmnopqrstuvwxyz0123.env",
        category: "AKIAABCDEFGHIJKLMNOP",
      }),
    ]).rows;
    expect(row?.file).toBe("config/[redacted].env");
    expect(row?.category).toBe("[redacted]");
    expect(row?.redacted).toBe(true);
  });
});

describe("finding bounds", () => {
  it("keeps 200 findings, drops malformed and over-long ones, and drops long optional fields", () => {
    const many = Array.from({ length: 250 }, (_, i) => finding({ fingerprint: `fp-${i}` }));
    expect(parseFindings(many)).toMatchObject({ truncated: true });
    expect(parseFindings(many).rows).toHaveLength(200);
    const over = "x".repeat(MAX_FIELD + 1);
    expect(
      parseFindings([
        finding({ severity: "fatal" }),
        finding({ reviewer: "bad id" }),
        { nope: 1 },
        finding({ title: over }),
        finding({ body: over }),
      ]),
    ).toMatchObject({ rows: [], dropped: 5 });
    const [row] = parseFindings([finding({ category: over, suggestion: over, code: over })]).rows;
    expect(row).toMatchObject({ category: null, suggestion: null, code: null });
  });

  it("cuts a field that redaction makes longer back to the cap", () => {
    // Each credential grows by two characters as [redacted].
    const body = "Bearer abcd1234 ".repeat(MAX_FIELD / 16);
    const [row] = parseFindings([finding({ body })]).rows;
    expect(row?.body).toHaveLength(MAX_FIELD);
    expect(row?.body).not.toContain("abcd1234");
    expect(row).toMatchObject({ redacted: true, truncated: true });
  });

  it("keeps a fix only while the server's pass leaves its replacement whole", () => {
    const fix = { startLine: 3, endLine: 4, replacement: "const limit = 10;" };
    const [kept] = parseFindings([finding({ fix })]).rows;
    expect(kept).toMatchObject({ fixStartLine: 3, fixEndLine: 4, fixReplacement: fix.replacement });
    const secret = { ...fix, replacement: "const token = 'Bearer abcd1234efgh5678';" };
    const [dropped] = parseFindings([finding({ fix: secret })]).rows;
    expect(dropped).toMatchObject({ fixStartLine: null, fixEndLine: null, fixReplacement: null });
    const [none] = parseFindings([finding({})]).rows;
    expect(none?.fixReplacement).toBeNull();
  });

  it("cuts a category at 64 characters", () => {
    const [row] = parseFindings([finding({ category: "c".repeat(100) })]).rows;
    expect(row?.category).toBe("c".repeat(64));
    expect(row?.truncated).toBe(true);
  });

  it("stores what a 0.6.0 CLI sends (redacted, then cut) and what a 0.7.0 CLI sends (cut, then redacted)", () => {
    const secret = `ghp_${"Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2)}`;
    const long = `${"word ".repeat(900)}${secret} ${"tail ".repeat(400)}`;
    const v060 = (value: string) => redact(value).text.slice(0, MAX_FIELD);
    const v070 = (value: string) => redactField(value).text;
    for (const cut of [v060, v070]) {
      const sent = finding({
        title: cut(`Token ${secret} in a test`),
        body: cut(long),
        code: cut(`const t = "${secret}";`),
        redacted: true,
        truncated: true,
      });
      const parsed = parseFindings([sent]);
      expect(parsed.dropped).toBe(0);
      expect(parsed.rows[0]).toMatchObject({
        title: sent.title,
        body: sent.body,
        code: sent.code,
        redacted: true,
        truncated: true,
      });
      expect(sent.body).toHaveLength(MAX_FIELD);
      expect(JSON.stringify(parsed.rows)).not.toContain(secret);
    }
  });

  it("keeps findings of every reviewer id the engine makes (audit K-models)", () => {
    // SARIF tool slugs may start with a digit or run long; plugins name their own.
    const ids = ["security", "2ms", `semgrep-${"x".repeat(60)}`, "Acme.Reviewer_2"];
    const parsed = parseFindings(ids.map((reviewer) => finding({ reviewer })));
    expect(parsed.rows.map((r) => r.reviewer)).toEqual(ids);
    expect(parsed.dropped).toBe(0);
  });
});

describe("sharing findings", () => {
  it("ignores findings while the switch is off, and keeps them redacted once it is on", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    const post = (runId: string, list: unknown[]) =>
      call("/api/reviews", {
        method: "POST",
        auth: cli.auth,
        json: upload(runId, list),
      });

    const off = (await (await post("run-off", [finding()])).json()) as {
      id: string;
      findings: number;
    };
    expect(off.findings).toBe(0);
    expect(await (await call("/api/account/salt", { auth: cli.auth })).json()).toEqual({
      salt: null,
    });

    const turnOn = await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    expect(turnOn.status).toBe(200);
    // A CLI token cannot change the switch.
    expect(
      (
        await call("/api/account/sharing", {
          method: "PUT",
          auth: cli.auth,
          json: {},
        })
      ).status,
    ).toBe(403);

    const on = (await (
      await post("run-on", [finding({ body: "leaked ghp_abcdefghijklmnopqrstuvwxyz0123 here" })])
    ).json()) as { id: string; findings: number };
    expect(on.findings).toBe(1);
    // The counts and the list travel side by side.
    const counts = (await (await call(`/api/reviews/${on.id}`, { auth: web.auth })).json()) as {
      review: { critical: number };
    };
    expect(counts.review.critical).toBe(1);
    const detail = (await (await call(`/api/reviews/${on.id}`, { auth: web.auth })).json()) as {
      findings: { body: string; redacted: boolean; file: string }[];
    };
    expect(detail.findings[0]).toMatchObject({ file: "src/db.ts", redacted: true });
    expect(detail.findings[0]?.body).not.toContain("ghp_");

    const exported = await call(`/api/reviews/${on.id}/export`, { auth: web.auth });
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const file = (await exported.json()) as { version: number; findings: unknown[] };
    expect(file).toMatchObject({ format: "ocra-cloud/review-export", version: 2 });
    // The report's findings[] names (engine docs/schema/report.v1.json), plus
    // ocra Cloud's redacted and truncated; nothing unknown is sent as null.
    expect(file.findings).toEqual([
      {
        fingerprint: "fp-1234",
        reviewer: "security",
        category: "injection",
        severity: "critical",
        verification: "confirmed",
        file: "src/db.ts",
        lines: { start: 10, end: 12 },
        title: "SQL built from input",
        body: expect.stringContaining("[redacted]"),
        suggestion: "Use a parameter.",
        code: 'db.query("SELECT * FROM t WHERE id=" + id)',
        redacted: true,
        truncated: false,
      },
    ]);

    const salt1 = (await (await call("/api/account/salt", { auth: cli.auth })).json()) as {
      salt: string;
    };
    const salt2 = (await (await call("/api/account/salt", { auth: web.auth })).json()) as {
      salt: string;
    };
    expect(salt1.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(salt2.salt).toBe(salt1.salt);

    const turnOff = await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: false, deleteExisting: true },
    });
    expect(await turnOff.json()).toEqual({ shareFindings: false, deleted: 1 });
    const after = (await (await call(`/api/reviews/${on.id}`, { auth: web.auth })).json()) as {
      findings: unknown[];
    };
    expect(after.findings).toEqual([]);
  });

  it("shows one account's findings to no other", async () => {
    const a = await signIn(1, "a");
    const b = await signIn(2, "b");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: a.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        auth: a.auth,
        json: upload("r", [finding()]),
      })
    ).json()) as { id: string };
    expect((await call(`/api/reviews/${posted.id}`, { auth: b.auth })).status).toBe(404);
    expect((await call(`/api/reviews/${posted.id}/export`, { auth: b.auth })).status).toBe(404);
  });
});

describe("an upload with crafted long fields", () => {
  // Audit E11: with redaction before the cut, 80k characters of a run such
  // as `a.a.a…` held the handler for 15 s or more per field.
  it("is answered within a second", { timeout: 300_000 }, async () => {
    const web = await signIn(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    const run = (unit: string, size = 80_000) => unit.repeat(size / unit.length);
    const list = [
      finding({ fingerprint: "fp-title", title: run("a.") }),
      finding({ fingerprint: "fp-code", body: run("a-", MAX_FIELD), code: run("a-") }),
    ];
    const start = Date.now();
    const res = await call("/api/reviews", {
      method: "POST",
      auth: web.auth,
      json: upload("run-crafted", list),
    });
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ findings: 1, dropped: { findings: 1 } });
  });
});
