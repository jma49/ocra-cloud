import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import type { InsightsImpactView } from "../src/shared/index.js";
import { finding, upload } from "./finding-uploads.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// A later review of a pull request names, by fingerprint, the earlier
// findings it saw fixed: the account's open ones on that pull request become
// fixed by re-review, once, and count so on the Insights page. What it saw
// dismissed is not recorded: the account's dismissals each name a reason.

beforeEach(resetDb);

const HEAD = "c".repeat(40);
const API = "https://github.com/mona/api";
const FPS = ["a", "b", "c", "d"].map((c) => c.repeat(16));
const [GONE = "", DISMISSED_ON_PLATFORM = "", DISMISSED = "", APPLIED = ""] = FPS;

async function sharing(githubId: number, login: string, on = true) {
  const me = await signIn(githubId, login);
  await db.update(accounts).set({ shareFindings: on }).where(eq(accounts.id, me.account.id));
  return { me, data: scoped(db, me.account.id) };
}

type Account = Awaited<ReturnType<typeof sharing>>;

async function post(a: Account, run: string, body: Record<string, unknown>) {
  const res = await call("/api/reviews", {
    method: "POST",
    auth: a.me.auth,
    json: { ...upload(run, []), ...body },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const reviewOf = (a: Account, run: string, repository: string, number: number) =>
  post(a, run, {
    pullRequest: { repository, number, headSha: HEAD },
    findingList: FPS.map((fingerprint) => finding({ fingerprint })),
  });

const rereview = (a: Account, run: string, repository: string, fixed: unknown[]) =>
  post(a, run, {
    findings: { critical: 0, warning: 0, suggestion: 0 },
    pullRequest: { repository, number: 1, headSha: HEAD },
    outcomes: {
      fixed: fixed.length,
      dismissed: 1,
      fixedFingerprints: fixed,
      dismissedFingerprints: [DISMISSED_ON_PLATFORM],
    },
    findingList: [],
  });

async function fates(a: Account, reviewId: string) {
  const rows = await a.data.findingsOf(reviewId);
  return Object.fromEntries(rows.map((f) => [f.fingerprint, [f.status, f.fixedVia]]));
}

describe("an upload's earlier findings fixed", () => {
  it("marks the account's open findings on that pull request fixed by re-review, once", async () => {
    const mona = await sharing(42, "mona");
    const bob = await sharing(43, "bob");
    const first = await reviewOf(mona, "run-1", API, 1);
    const otherPull = await reviewOf(mona, "run-2", API, 2);
    const bobs = await reviewOf(bob, "run-3", API, 1);
    const ids = new Map((await mona.data.findingsOf(first)).map((f) => [f.fingerprint, f.id]));
    await mona.data.decide([ids.get(DISMISSED) ?? ""], {
      status: "dismissed",
      reason: "false_positive",
      note: null,
      decidedAt: new Date(),
    });
    await mona.data.findingOutcomes.markFixed([ids.get(APPLIED) ?? ""], "applied");

    // The repository as the CLI names it, in another case; a repeated fingerprint and a dropped entry.
    await rereview(mona, "run-4", "https://github.com/Mona/API", [
      GONE,
      DISMISSED,
      APPLIED,
      GONE,
      "not a fingerprint",
    ]);

    expect(await fates(mona, first)).toEqual({
      [GONE]: ["fixed", "rereview"],
      [DISMISSED_ON_PLATFORM]: ["open", null],
      [DISMISSED]: ["dismissed", null],
      [APPLIED]: ["fixed", "applied"],
    });
    // Another pull request's findings, and another account's on the same one, keep theirs.
    expect((await fates(mona, otherPull))[GONE]).toEqual(["open", null]);
    expect((await fates(bob, bobs))[GONE]).toEqual(["open", null]);

    const res = await call("/api/insights/impact?days=7", { auth: mona.me.auth });
    const view = (await res.json()) as InsightsImpactView;
    expect(view.total.actedOn?.fixedVia).toEqual({
      applied: 1,
      suggestion: 0,
      manual: 0,
      rereview: 1,
      unknown: 0,
    });
    expect(view.total.actedOn).toMatchObject({ fixed: 2, dismissed: 1 });
  });

  it("records nothing for an account that does not share findings", async () => {
    const mona = await sharing(42, "mona");
    const first = await reviewOf(mona, "run-1", API, 1);
    await db
      .update(accounts)
      .set({ shareFindings: false })
      .where(eq(accounts.id, mona.me.account.id));
    await rereview(mona, "run-2", API, [GONE]);
    expect((await fates(mona, first))[GONE]).toEqual(["open", null]);
    await db
      .update(accounts)
      .set({ shareFindings: true })
      .where(eq(accounts.id, mona.me.account.id));
    await rereview(mona, "run-3", API, [GONE]);
    expect((await fates(mona, first))[GONE]).toEqual(["fixed", "rereview"]);
  });
});
