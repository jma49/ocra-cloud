import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index.js";
import { type CallInit, call, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);

const finding = (i: number) => ({
  fingerprint: `fp-${i}`,
  reviewer: "security",
  severity: "warning",
  file: `src/f${i}.ts`,
  lineStart: i + 1,
  lineEnd: i + 1,
  title: `Finding ${i}`,
  body: "Body.",
});
const upload = (runId: string, n = 0) => ({
  runId,
  repoHash: "c".repeat(64),
  source: "local",
  findings: { critical: 0, warning: n, suggestion: 0 },
  findingList: Array.from({ length: n }, (_, i) => finding(i)),
});

/** Calls the app with a D1 binding that counts the statements it prepares. */
async function counted(path: string, init: CallInit) {
  let statements = 0;
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare")
        return (q: string) => {
          statements++;
          return target.prepare(q);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ctx = createExecutionContext();
  const res = await app.fetch(request(path, init), { ...env, DB }, ctx);
  const body = await res.json();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body, statements };
}

async function share(web: { authorization: string }) {
  await call("/api/account/sharing", {
    method: "PUT",
    auth: web,
    headers: { origin: ORIGIN },
    json: { enabled: true },
  });
}

describe("review uploads", () => {
  it("concurrent uploads of one run store one review and all answer", async () => {
    const { auth } = await signInCli(1, "octo");
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        call("/api/reviews", {
          method: "POST",
          auth,
          json: upload("run-1"),
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { id: string }[];
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    const web = await signIn(1, "octo");
    const list = (await (await call("/api/reviews", { auth: web.auth })).json()) as {
      reviews: unknown[];
    };
    expect(list.reviews).toHaveLength(1);
  });

  it("200 shared findings go in with a bounded number of statements", async () => {
    const web = await signIn(1, "octo");
    await share(web.auth);
    const { auth } = await signInCli(1, "octo");
    const res = await counted("/api/reviews", {
      method: "POST",
      auth,
      json: upload("run-big", 200),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ findings: 200 });
    expect(res.statements).toBeLessThan(15);
    const id = (res.body as { id: string }).id;
    const detail = (await (await call(`/api/reviews/${id}`, { auth: web.auth })).json()) as {
      findings: { fingerprint: string; redacted: boolean; lineStart: number }[];
    };
    expect(detail.findings).toHaveLength(200);
    expect(detail.findings.find((f) => f.fingerprint === "fp-7")).toMatchObject({
      lineStart: 8,
      redacted: false,
    });
    // A retry stores nothing more.
    const again = await counted("/api/reviews", {
      method: "POST",
      auth,
      json: upload("run-big", 200),
    });
    expect(again.body).toEqual({ id, duplicate: true });
  });

  it("stores every field of a finding in its own column", async () => {
    const web = await signIn(1, "octo");
    await share(web.auth);
    const { auth } = await signInCli(1, "octo");
    const sent = {
      fingerprint: "fp-distinct",
      reviewer: "logic",
      severity: "suggestion",
      category: "naming",
      verification: "uncertain",
      file: "src/distinct.ts",
      lineStart: 11,
      lineEnd: 13,
      title: "The title",
      body: "The body",
      suggestion: "The suggestion",
      code: "the(code)",
      truncated: true,
    };
    const res = await call("/api/reviews", {
      method: "POST",
      auth: auth,
      json: { ...upload("run-cols"), findingList: [sent] },
    });
    const { id } = (await res.json()) as { id: string };
    const detail = (await (await call(`/api/reviews/${id}`, { auth: web.auth })).json()) as {
      findings: Record<string, unknown>[];
    };
    expect(detail.findings).toEqual([
      expect.objectContaining({ ...sent, redacted: false, truncated: true }),
    ]);
  });

  it("turning sharing off deletes the stored findings in a bounded number of statements", async () => {
    const web = await signIn(1, "octo");
    await share(web.auth);
    const { auth } = await signInCli(1, "octo");
    await call("/api/reviews", {
      method: "POST",
      auth,
      json: upload("r", 120),
    });
    const off = await counted("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json: { enabled: false, deleteExisting: true },
    });
    expect(off.body).toMatchObject({ shareFindings: false, deleted: 120 });
    expect(off.statements).toBeLessThan(10);
  });
});
