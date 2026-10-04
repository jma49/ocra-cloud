import { beforeEach, describe, expect, it } from "vitest";
import vectors from "../src/contract/fixtures/redaction-vectors.json";
import { redact } from "../src/contract/index.js";
import { parseFindings } from "../src/findings.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);
const json = { "content-type": "application/json" };
const HASH = "b".repeat(64);

const finding = (over: Record<string, unknown> = {}) => ({
  fingerprint: "fp-1234",
  reviewer: "security",
  severity: "critical",
  category: "injection",
  verification: "confirmed",
  file: "src/db.ts",
  lineStart: 10,
  lineEnd: 12,
  title: "SQL built from input",
  body: "The query concatenates user input.",
  suggestion: "Use a parameter.",
  code: 'db.query("SELECT * FROM t WHERE id=" + id)',
  ...over,
});
const upload = (runId: string, findingList: unknown[]) => ({
  runId,
  repoHash: HASH,
  source: "local",
  findings: { critical: 1, warning: 0, suggestion: 0 },
  findingList,
});

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
  it("keeps 200 findings, cuts long fields, and drops malformed ones", () => {
    const many = Array.from({ length: 250 }, (_, i) => finding({ fingerprint: `fp-${i}` }));
    expect(parseFindings(many)).toMatchObject({ truncated: true });
    expect(parseFindings(many).rows).toHaveLength(200);
    const long = parseFindings([finding({ body: "x".repeat(10_000) })]).rows[0];
    expect(long?.body).toHaveLength(4096);
    expect(long?.truncated).toBe(true);
    expect(
      parseFindings([finding({ severity: "fatal" }), finding({ reviewer: "bad id" }), { nope: 1 }]),
    ).toMatchObject({ rows: [], dropped: 3 });
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
        headers: { ...cli.auth, ...json },
        body: JSON.stringify(upload(runId, list)),
      });

    const off = (await (await post("run-off", [finding()])).json()) as {
      id: string;
      findings: number;
    };
    expect(off.findings).toBe(0);
    expect(await (await call("/api/account/salt", { headers: cli.auth })).json()).toEqual({
      salt: null,
    });

    const turnOn = await call("/api/account/sharing", {
      method: "PUT",
      headers: { ...web.auth, ...json, origin: "https://ocra.test" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(turnOn.status).toBe(200);
    // A CLI token cannot change the switch.
    expect(
      (
        await call("/api/account/sharing", {
          method: "PUT",
          headers: { ...cli.auth, ...json },
          body: "{}",
        })
      ).status,
    ).toBe(403);

    const on = (await (
      await post("run-on", [finding({ body: "leaked ghp_abcdefghijklmnopqrstuvwxyz0123 here" })])
    ).json()) as { id: string; findings: number };
    expect(on.findings).toBe(1);
    // The counts and the list travel side by side.
    const counts = (await (await call(`/api/reviews/${on.id}`, { headers: web.auth })).json()) as {
      review: { critical: number };
    };
    expect(counts.review.critical).toBe(1);
    const detail = (await (await call(`/api/reviews/${on.id}`, { headers: web.auth })).json()) as {
      findings: { body: string; redacted: boolean; file: string }[];
    };
    expect(detail.findings[0]).toMatchObject({ file: "src/db.ts", redacted: true });
    expect(detail.findings[0]?.body).not.toContain("ghp_");

    const exported = await call(`/api/reviews/${on.id}/export`, { headers: web.auth });
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

    const salt1 = (await (await call("/api/account/salt", { headers: cli.auth })).json()) as {
      salt: string;
    };
    const salt2 = (await (await call("/api/account/salt", { headers: web.auth })).json()) as {
      salt: string;
    };
    expect(salt1.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(salt2.salt).toBe(salt1.salt);

    const turnOff = await call("/api/account/sharing", {
      method: "PUT",
      headers: { ...web.auth, ...json, origin: "https://ocra.test" },
      body: JSON.stringify({ enabled: false, deleteExisting: true }),
    });
    expect(await turnOff.json()).toEqual({ shareFindings: false, deleted: 1 });
    const after = (await (await call(`/api/reviews/${on.id}`, { headers: web.auth })).json()) as {
      findings: unknown[];
    };
    expect(after.findings).toEqual([]);
  });

  it("shows one account's findings to no other", async () => {
    const a = await signIn(1, "a");
    const b = await signIn(2, "b");
    await call("/api/account/sharing", {
      method: "PUT",
      headers: { ...a.auth, ...json, origin: "https://ocra.test" },
      body: JSON.stringify({ enabled: true }),
    });
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        headers: { ...a.auth, ...json },
        body: JSON.stringify(upload("r", [finding()])),
      })
    ).json()) as { id: string };
    expect((await call(`/api/reviews/${posted.id}`, { headers: b.auth })).status).toBe(404);
    expect((await call(`/api/reviews/${posted.id}/export`, { headers: b.auth })).status).toBe(404);
  });
});

describe("account memory", () => {
  it("remembers a finding once per repository, lists it for the CLI, and deletes it", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      headers: { ...web.auth, ...json, origin: "https://ocra.test" },
      body: JSON.stringify({ enabled: true }),
    });
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        headers: { ...cli.auth, ...json },
        body: JSON.stringify(upload("r", [finding()])),
      })
    ).json()) as { id: string };
    const detail = (await (
      await call(`/api/reviews/${posted.id}`, { headers: web.auth })
    ).json()) as { findings: { id: string }[] };
    const findingId = detail.findings[0]?.id;
    const remember = (reason: string) =>
      call("/api/memory", {
        method: "POST",
        headers: { ...web.auth, ...json, origin: "https://ocra.test" },
        body: JSON.stringify({ findingId, reason }),
      });
    expect((await remember("")).status).toBe(400);
    const first = (await (await remember("Accepted: internal tool")).json()) as { id: string };
    expect(await (await remember("again")).json()).toEqual({ id: first.id, duplicate: true });

    const list = (await (await call(`/api/memory?repo=${HASH}`, { headers: cli.auth })).json()) as {
      entries: { fingerprint: string; reason: string }[];
    };
    expect(list.entries).toMatchObject([
      { fingerprint: "fp-1234", reason: "Accepted: internal tool" },
    ]);
    expect(
      (await call(`/api/memory?repo=${"c".repeat(64)}`, { headers: cli.auth }).then((r) =>
        r.json(),
      )) as unknown,
    ).toEqual({ entries: [] });
    // The CLI reads memory; only the web changes it.
    expect(
      (await call("/api/memory", { method: "POST", headers: { ...cli.auth, ...json }, body: "{}" }))
        .status,
    ).toBe(403);

    await call(`/api/memory/${first.id}`, {
      method: "DELETE",
      headers: { ...web.auth, origin: "https://ocra.test" },
    });
    expect(
      ((await (await call("/api/memory", { headers: web.auth })).json()) as { entries: unknown[] })
        .entries,
    ).toEqual([]);
  });
});
