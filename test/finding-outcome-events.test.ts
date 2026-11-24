import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { recordGithubClose, recordGitlabClose } from "../src/auto-review/closes.js";
import { accounts, findings } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import { reviewRow } from "../src/reviews.js";
import { bot, enrolled, FP, HUB, PR, thread } from "./finding-events-fakes.js";
import { finding, upload } from "./finding-uploads.js";
import { seed } from "./fix-fakes.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// What happens on the platform moves ocra's finding out of the open state:
// a person resolving its comment's thread (addressed, open again when they
// reopen it), a later review seeing it fixed (fixed, even once addressed or
// merged) and its pull request merging with it still open (merged). A
// decision the account made is never overwritten.

beforeEach(resetDb);

const closed = (merged: boolean, number = 7) =>
  recordGithubClose(db, "github.com", HUB, {
    action: "closed",
    number,
    pull_request: {
      title: "feat: honour Retry-After",
      merged,
      created_at: "2026-11-02T09:00:00Z",
      closed_at: "2026-11-02T14:00:00Z",
      merged_at: merged ? "2026-11-02T14:00:00Z" : null,
    },
    repository: { id: 11 },
  });

const fixedOnRereview = (data: Awaited<ReturnType<typeof enrolled>>["data"]) =>
  data.findingOutcomes.markFixedOnRereview({ identity: PR, number: 7, fingerprints: [FP] });

describe("a finding's thread on the platform", () => {
  it("makes an open finding addressed when a person resolves it, and open again when reopened", async () => {
    const { data } = await enrolled();
    const { id } = await seed(PR, 7, { fingerprint: FP });
    await thread("resolved", "2026-11-02T12:00:00Z");
    expect(await data.get("findings", id)).toMatchObject({
      status: "addressed",
      decidedAt: new Date("2026-11-02T12:00:00Z"),
      threadResolvedAt: new Date("2026-11-02T12:00:00Z"),
    });
    // A late, older delivery moves nothing.
    await thread("unresolved", "2026-11-02T11:00:00Z");
    expect((await data.get("findings", id))?.status).toBe("addressed");
    await thread("unresolved", "2026-11-02T13:00:00Z");
    expect(await data.get("findings", id)).toMatchObject({
      status: "open",
      decidedAt: null,
      threadResolvedAt: null,
    });
  });

  it("leaves a finding the account decided on as it is, and a bot's resolution moves nothing", async () => {
    const { data } = await enrolled();
    const { id } = await seed(PR, 7, { fingerprint: FP });
    await thread("resolved", "2026-11-02T12:00:00Z", bot);
    expect((await data.get("findings", id))?.status).toBe("open");
    const decidedAt = new Date("2026-11-02T11:00:00Z");
    await data.decide([id], {
      status: "dismissed",
      reason: "not_important",
      note: null,
      decidedAt,
    });
    await thread("resolved", "2026-11-02T12:00:00Z");
    await thread("unresolved", "2026-11-02T13:00:00Z");
    expect(await data.get("findings", id)).toMatchObject({ status: "dismissed", decidedAt });
  });

  it("is fixed when a later review no longer finds it, though its thread was resolved", async () => {
    const { data } = await enrolled();
    const { id } = await seed(PR, 7, { fingerprint: FP });
    await thread("resolved", "2026-11-02T12:00:00Z");
    expect(await fixedOnRereview(data)).toBe(1);
    expect(await data.get("findings", id)).toMatchObject({
      status: "fixed",
      fixedVia: "rereview",
    });
  });
});

describe("a merged pull request", () => {
  it("makes its findings still open merged, and leaves the rest as they are", async () => {
    const { data } = await enrolled();
    const open = await seed(PR, 7, { fingerprint: FP }, "run-1");
    const addressed = await seed(PR, 7, { fingerprint: "fedcba9876543210" }, "run-2");
    const fixed = await seed(PR, 7, { fingerprint: "1111111111111111" }, "run-3");
    const elsewhere = await seed(PR, 8, { fingerprint: FP }, "run-4");
    await db.update(findings).set({ status: "addressed" }).where(eq(findings.id, addressed.id));
    await data.findingOutcomes.markFixed([fixed.id], "applied");
    expect(await closed(true)).toBe(true);
    expect(await data.get("findings", open.id)).toMatchObject({
      status: "merged",
      decidedAt: new Date("2026-11-02T14:00:00Z"),
    });
    expect((await data.get("findings", addressed.id))?.status).toBe("addressed");
    expect((await data.get("findings", fixed.id))?.status).toBe("fixed");
    expect((await data.get("findings", elsewhere.id))?.status).toBe("open");
    // A fix a later review sees still counts.
    expect(await fixedOnRereview(data)).toBe(1);
    expect((await data.get("findings", open.id))?.status).toBe("fixed");
  });

  it("moves only the enrolling account's findings, not another's review of the same pull request", async () => {
    await enrolled();
    const other = await signIn(43, "nat");
    const data = scoped(db, other.account.id);
    const { reviewersDropped: _, ...row } = reviewRow(
      reviewUploadSchema.parse({
        ...upload("run-nat", []),
        pullRequest: { repository: PR, number: 7, headSha: "b".repeat(40) },
      }),
    );
    const stored = await data.insertReview(
      row,
      parseFindings([finding({ fingerprint: FP })]).rows,
      {
        dailyUploads: 10,
        maxFindings: 10,
      },
    );
    if (stored.outcome !== "stored") throw new Error(stored.outcome);
    await thread("resolved", "2026-11-02T12:00:00Z");
    expect(await closed(true)).toBe(true);
    expect((await data.findingsOf(stored.id)).map((f) => f.status)).toEqual(["open"]);
  });

  it("makes a merged GitLab merge request's open findings merged", async () => {
    const { data } = await enrolled();
    const id = await data.insert("reviewRepos", {
      platform: "gitlab",
      host: "gitlab.test",
      platformRepoId: "9",
      fullName: "Group/API",
    });
    const repo = await data.get("reviewRepos", id);
    if (!repo) throw new Error("not enrolled");
    const open = await seed("https://gitlab.test/group/api", 3, { fingerprint: FP });
    const hook = (state: "merged" | "closed") => ({
      object_attributes: {
        iid: 3,
        action: state === "merged" ? "merge" : "close",
        state,
        title: "T",
      },
    });
    expect(await recordGitlabClose(db, repo, "https://gitlab.test", hook("closed"))).toBe(true);
    expect((await data.get("findings", open.id))?.status).toBe("open");
    expect(await recordGitlabClose(db, repo, "https://gitlab.test", hook("merged"))).toBe(true);
    expect((await data.get("findings", open.id))?.status).toBe("merged");
  });

  it("leaves a closed pull request's findings open: it may be reopened", async () => {
    const { data } = await enrolled();
    const { id } = await seed(PR, 7, { fingerprint: FP });
    expect(await closed(false)).toBe(true);
    expect((await data.get("findings", id))?.status).toBe("open");
  });

  it("counts addressed and merged findings on the Insights page, not as open", async () => {
    const { me } = await enrolled();
    await db.update(accounts).set({ shareFindings: true }).where(eq(accounts.id, me.account.id));
    await seed(PR, 7, { fingerprint: FP }, "run-1");
    await seed(PR, 9, { fingerprint: FP }, "run-2");
    await thread("resolved", "2026-11-02T12:00:00Z");
    await closed(true, 9);
    const res = await call("/api/insights/impact?days=30", { auth: me.auth });
    const body = (await res.json()) as { total: { actedOn: Record<string, number> } };
    expect(body.total.actedOn).toMatchObject({
      open: 0,
      addressed: 1,
      merged: 1,
      threadResolved: 1,
    });
  });

  it("refuses addressed or merged as a decision: only the platform says those", async () => {
    const { me } = await enrolled();
    const { id } = await seed(PR, 7, { fingerprint: FP });
    for (const status of ["addressed", "merged"]) {
      const res = await call("/api/findings/decide", {
        method: "POST",
        auth: me.auth,
        json: { ids: [id], status },
      });
      expect(res.status).toBe(400);
    }
  });
});
