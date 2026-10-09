import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import app from "../src/index.js";
import { DAY, utcDay } from "../src/time.js";
import { call, db, ORIGIN, request, resetDb, signIn, signInCli } from "./helpers.js";

// Audit S3: uploads per account per day and shared findings per account are
// capped, so one account cannot fill the database. Audit C1: the findings
// counted are those sent within the retention window, so the cap bounds the
// rows written as well as the rows kept.

beforeEach(resetDb);

const upload = (runId: string, n = 0) => ({
  runId,
  repoHash: "d".repeat(64),
  source: "local",
  findings: { critical: 0, warning: n, suggestion: 0 },
  findingList: Array.from({ length: n }, (_, i) => ({
    fingerprint: `fp-${i}`,
    reviewer: "security",
    severity: "warning",
    file: `src/f${i}.ts`,
    title: `Finding ${i}`,
    body: "Body.",
  })),
});

/** Posts an upload with the limits set to the given values. */
async function post(
  auth: { authorization: string },
  body: unknown,
  limits: { REVIEW_DAILY_UPLOADS?: string; REVIEW_MAX_FINDINGS?: string },
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    request("/api/reviews", { method: "POST", auth, json: body }),
    { ...env, ...limits },
    ctx,
  );
  const out = { status: res.status, body: (await res.json()) as Record<string, unknown> };
  await waitOnExecutionContext(ctx);
  return out;
}

async function stored(web: { authorization: string }) {
  const res = await call("/api/reviews", { auth: web });
  return ((await res.json()) as { reviews: { id: string }[] }).reviews;
}

describe("review upload limits", () => {
  it("answers 429 past the daily cap, and a retry of a stored run still answers", async () => {
    const { auth } = await signInCli(1, "octo");
    const cap = { REVIEW_DAILY_UPLOADS: "2" };
    expect((await post(auth, upload("a"), cap)).status).toBe(200);
    const b = await post(auth, upload("b"), cap);
    expect(b.status).toBe(200);
    const c = await post(auth, upload("c"), cap);
    expect(c).toEqual({ status: 429, body: { error: "daily_limit", limit: 2 } });
    // A retry is not a new upload.
    expect(await post(auth, upload("b"), cap)).toEqual({
      status: 200,
      body: { id: b.body.id, duplicate: true },
    });
    const web = await signIn(1, "octo");
    expect(await stored(web.auth)).toHaveLength(2);
    // Another account has its own count.
    const other = await signInCli(2, "hubot");
    expect((await post(other.auth, upload("a"), cap)).status).toBe(200);
  });

  it("holds the daily cap under concurrent uploads", async () => {
    const { auth } = await signInCli(1, "octo");
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => post(auth, upload(`run-${i}`), { REVIEW_DAILY_UPLOADS: "2" })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    const web = await signIn(1, "octo");
    expect(await stored(web.auth)).toHaveLength(2);
  });

  it("stores a review without its findings past the account's findings cap", async () => {
    const web = await signIn(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json: { enabled: true },
    });
    const { auth } = await signInCli(1, "octo");
    const cap = { REVIEW_MAX_FINDINGS: "250" };
    expect((await post(auth, upload("first", 200), cap)).body).toMatchObject({ findings: 200 });
    const second = await post(auth, upload("second", 100), cap);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ findings: 0, findingsSkipped: "account_limit" });
    const detail = (await (
      await call(`/api/reviews/${second.body.id}`, { auth: web.auth })
    ).json()) as { review: { runId: string }; findings: unknown[] };
    expect(detail.review.runId).toBe("second");
    expect(detail.findings).toHaveLength(0);
    // Findings that fit still go in.
    expect((await post(auth, upload("third", 50), cap)).body).toMatchObject({ findings: 50 });
  });
});

describe("the findings allowance", () => {
  async function sharingAccount() {
    const web = await signIn(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: ORIGIN },
      json: { enabled: true },
    });
    const cli = await signInCli(1, "octo");
    return { web: web.auth, cli: cli.auth, data: scoped(db, web.account.id) };
  }
  const cap = { REVIEW_MAX_FINDINGS: "250" };

  it("is not given back by deleting findings, and the web is told what it is", async () => {
    const { web, cli } = await sharingAccount();
    const shown = await call("/api/account/sharing", { auth: web });
    expect(await shown.json()).toMatchObject({ findingsAllowance: 20_000 });
    const first = await post(cli, upload("first", 200), cap);
    expect(first.body).toMatchObject({ findings: 200 });
    const removed = await call(`/api/reviews/${first.body.id}`, { method: "DELETE", auth: web });
    expect(await removed.json()).toEqual({ removed: true });
    const second = await post(cli, upload("second", 100), cap);
    expect(second.body).toMatchObject({ findings: 0, findingsSkipped: "account_limit" });
  });

  it("counts the findings sent within the retention window only", async () => {
    const { cli, data } = await sharingAccount();
    const day = (daysAgo: number) => utcDay(new Date(Date.now() - daysAgo * DAY));
    await data.insert("usageCounters", { kind: "findings", day: day(91), n: 250 });
    expect((await post(cli, upload("a", 100), cap)).body).toMatchObject({ findings: 100 });
    await data.insert("usageCounters", { kind: "findings", day: day(90), n: 100 });
    const b = await post(cli, upload("b", 100), cap);
    expect(b.body).toMatchObject({ findings: 0, findingsSkipped: "account_limit" });
  });
});
