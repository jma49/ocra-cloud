import { beforeEach, describe, expect, it } from "vitest";
import { parseFindings } from "../src/findings.js";
import { redact } from "../src/redact.js";
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
  it("replaces common secrets and long random tokens, and leaves code alone", () => {
    for (const secret of [
      "AKIAABCDEFGHIJKLMNOP",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "sk-or-v1-0123456789abcdef0123456789abcdef",
      "AIzaSyA-1234567890abcdefghijklmnopqrstu",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "Zq3Xk9LmP2vR7tYb4NcW8sJh1Df6Ga5Ue0Oi",
    ]) {
      const r = redact(`const key = "${secret}";`);
      expect(r.redacted).toBe(true);
      expect(r.text).not.toContain(secret.slice(0, 12));
    }
    const plain = redact(
      "const total = items.reduce((n, i) => n + i.price, 0); // a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    );
    expect(plain.redacted).toBe(false);
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
      parseFindings([finding({ severity: "fatal" }), finding({ reviewer: "Bad" }), { nope: 1 }])
        .rows,
    ).toEqual([]);
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
    expect(await exported.json()).toMatchObject({
      format: "ocra-cloud/review-export",
      version: 1,
      findings: [{ lines: { start: 10, end: 12 } }],
    });

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
