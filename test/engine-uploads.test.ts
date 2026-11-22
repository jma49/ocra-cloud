import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import fixture from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { reviewRow, withoutSharedText } from "../src/reviews.js";
import { call, db, resetDb, signIn, signInCli } from "./helpers.js";

// What a pull request's review uploads beside its counts (the contract's
// linkedTasks, learnings and mergeChecks): kept as sent, absent apart from
// empty, and their text only while the account shares findings.

beforeEach(resetDb);
const { about: _, ...body } = fixture;
const { linkedTasks: _l, learnings: _g, mergeChecks: _m, ...older } = body;
const rowOf = (upload: unknown) => {
  const { reviewersDropped: _r, ...row } = reviewRow(reviewUploadSchema.parse(upload));
  return row;
};

describe("a review's row", () => {
  it("keeps an absent list null and an empty one empty", () => {
    expect(rowOf(older)).toMatchObject({ linkedTasks: null, learnings: null, mergeChecks: null });
    expect(rowOf({ ...older, linkedTasks: [], learnings: [], mergeChecks: [] })).toMatchObject({
      linkedTasks: [],
      learnings: [],
      mergeChecks: [],
    });
  });

  it("keeps the fixture's lists as sent, and only their names without sharing", () => {
    const row = rowOf(body);
    expect(row).toMatchObject({
      linkedTasks: body.linkedTasks,
      learnings: body.learnings,
      mergeChecks: body.mergeChecks,
    });
    const bare = withoutSharedText(row);
    expect(bare.linkedTasks).toEqual(body.linkedTasks.map(({ title: _t, labels: _s, ...t }) => t));
    expect(bare.mergeChecks).toEqual(body.mergeChecks.map(({ id, outcome }) => ({ id, outcome })));
    expect(bare.learnings).toEqual(body.learnings);
    expect(withoutSharedText({ ...row, prRepository: null }).learnings).toBeNull();
    expect(withoutSharedText(rowOf(older))).toMatchObject({
      linkedTasks: null,
      learnings: null,
      mergeChecks: null,
    });
  });
});

async function upload(json: unknown, share: boolean) {
  const cli = await signInCli(1, "octo");
  const web = await signIn(1, "octo");
  if (share) {
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
  }
  const posted = (await (
    await call("/api/reviews", { method: "POST", auth: cli.auth, json })
  ).json()) as { id: string };
  const detail = (await (await call(`/api/reviews/${posted.id}`, { auth: web.auth })).json()) as {
    review: Record<string, unknown>;
  };
  return detail.review;
}

describe("the review's detail", () => {
  it("answers the uploaded linked tasks, learnings and checks' outcomes", async () => {
    expect(await upload(body, true)).toMatchObject({
      linkedTasks: body.linkedTasks,
      learnings: body.learnings,
      mergeChecks: body.mergeChecks,
    });
  });

  it("drops their text when the account does not share findings", async () => {
    const review = await upload(body, false);
    expect(JSON.stringify(review)).not.toContain(body.linkedTasks[0]?.title);
    expect(JSON.stringify(review)).not.toContain(body.mergeChecks[0]?.reason);
    expect(review.mergeChecks).toEqual([{ id: body.mergeChecks[0]?.id, outcome: "failed" }]);
  });

  it("answers null for a client that did not say, and empty for none", async () => {
    expect(await upload(older, true)).toMatchObject({
      linkedTasks: null,
      learnings: null,
      mergeChecks: null,
    });
    expect(
      await upload({ ...older, runId: "run-empty", linkedTasks: [], learnings: [] }, true),
    ).toMatchObject({ linkedTasks: [], learnings: [], mergeChecks: null });
  });
});

describe("a learning's use", () => {
  const DAY = 86_400_000;
  const now = Date.now();
  async function review(accountId: string, n: number, over: Record<string, unknown>) {
    await scoped(db, accountId).insert("reviews", {
      runId: `run-${n}`,
      repoHash: "h1",
      source: "github" as const,
      ...over,
    });
  }

  it("counts the repository's reviews in the window that named it, and the newest", async () => {
    const a = (await signIn(1, "octo")).account.id;
    const b = (await signIn(2, "other")).account.id;
    await review(a, 1, { learnings: ["pools", "retry", "pools"], createdAt: new Date(now - DAY) });
    await review(a, 2, { learnings: ["pools", null], createdAt: new Date(now - 2 * DAY) });
    await review(a, 3, { learnings: ["pools"], createdAt: new Date(now - 100 * DAY) });
    await review(a, 4, { learnings: ["pools"], repoHash: "h2" });
    await review(a, 5, { learnings: null });
    await review(a, 6, { learnings: [] });
    await review(b, 7, { learnings: ["pools"] });
    const used = await scoped(db, a).learningUsage(
      "h1",
      ["pools", "retry", "unused"],
      new Date(now - 90 * DAY),
    );
    expect(used.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "pools", reviews: 2, lastUsedAt: new Date(now - DAY) },
      { id: "retry", reviews: 1, lastUsedAt: new Date(now - DAY) },
    ]);
    expect(await scoped(db, a).learningUsage("h1", [], new Date(0))).toEqual([]);
  });
});
