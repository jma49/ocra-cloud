import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index.js";
import { call, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

// Audit S3: uploads per account per day and stored findings per account are
// capped, so one account cannot fill the database.

beforeEach(resetDb);
const json = { "content-type": "application/json" };

const upload = (runId: string, n = 0) =>
  JSON.stringify({
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
  body: string,
  limits: { REVIEW_DAILY_UPLOADS?: string; REVIEW_MAX_FINDINGS?: string },
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/reviews`, { method: "POST", headers: { ...json, ...auth }, body }),
    { ...env, ...limits },
    ctx,
  );
  const out = { status: res.status, body: (await res.json()) as Record<string, unknown> };
  await waitOnExecutionContext(ctx);
  return out;
}

async function stored(web: { authorization: string }) {
  const res = await call("/api/reviews", { headers: web });
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
      headers: { ...json, ...web.auth, origin: ORIGIN },
      body: JSON.stringify({ enabled: true }),
    });
    const { auth } = await signInCli(1, "octo");
    const cap = { REVIEW_MAX_FINDINGS: "250" };
    expect((await post(auth, upload("first", 200), cap)).body).toMatchObject({ findings: 200 });
    const second = await post(auth, upload("second", 100), cap);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ findings: 0, findingsSkipped: "account_limit" });
    const detail = (await (
      await call(`/api/reviews/${second.body.id}`, { headers: web.auth })
    ).json()) as { review: { runId: string }; findings: unknown[] };
    expect(detail.review.runId).toBe("second");
    expect(detail.findings).toHaveLength(0);
    // Findings that fit still go in.
    expect((await post(auth, upload("third", 50), cap)).body).toMatchObject({ findings: 50 });
  });
});
