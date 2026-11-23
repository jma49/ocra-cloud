import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { startHostedFindings } from "../src/db/accounts.js";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { startCliSession } from "../src/session.js";
import { finding, upload } from "./finding-uploads.js";
import { call, db, JSON_TYPE, resetDb, signIn, signInCli } from "./helpers.js";

// Findings of the reviews this server runs are kept from the account's first
// such review, without the account sharing findings; a CLI's own are not.

beforeEach(resetDb);

const repo = {
  platform: "github" as const,
  host: "github.com",
  platformRepoId: "11",
  fullName: "octo/api",
};

/** A hosted run's CLI session: it carries its job's id, as the server starts it. */
async function hostedRun(accountId: string) {
  const jobs = scoped(db, accountId).autoReview;
  const repoId = (await jobs.enroll(repo, 100)) ?? "";
  await jobs.queue(repoId, 7, "a".repeat(40), new Date());
  const [job] = await db.select().from(schema.reviewJobs);
  const tokens = await startCliSession(db, accountId, "auto review", job?.id);
  return { authorization: `Bearer ${tokens.access_token}` };
}

const send = (auth: Record<string, string>, runId: string) =>
  call("/api/reviews", {
    method: "POST",
    headers: { ...auth, ...JSON_TYPE },
    body: JSON.stringify(upload(runId, [finding()])),
  });

const stored = async () => (await db.select().from(schema.findings)).length;
const sharing = async (auth: Record<string, string>) =>
  (await (await call("/api/account/sharing", { headers: auth })).json()) as Record<string, unknown>;

describe("findings of hosted reviews", () => {
  it("are kept and shown for an account that does not share findings", async () => {
    const me = await signIn(1, "me");
    const run = await hostedRun(me.account.id);
    await startHostedFindings(db, me.account.id);
    expect(await (await call("/api/account/salt", { headers: run })).json()).toMatchObject({
      salt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const res = await send(run, "run-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ findings: 1 });
    expect(await stored()).toBe(1);
    // The web shows them, and says the account's own choice still stands.
    expect(await sharing(me.auth)).toMatchObject({
      shareFindings: false,
      hostedFindings: true,
      findingsStored: 1,
    });
    const search = await call("/api/search?q=", { headers: me.auth });
    expect(await search.json()).toMatchObject({ findings: [] });
  });

  it("leave a CLI on the user's own machine as it was: nothing kept unless shared", async () => {
    const me = await signInCli(1, "me");
    await hostedRun(me.account.id);
    await startHostedFindings(db, me.account.id);
    expect(await (await call("/api/account/salt", { headers: me.auth })).json()).toEqual({
      salt: null,
    });
    expect(await (await send(me.auth, "run-1")).json()).toMatchObject({ findings: 0 });
    expect(await stored()).toBe(0);
  });

  it("are not kept before the server ran a review for the account", async () => {
    const me = await signIn(1, "me");
    const run = await hostedRun(me.account.id);
    expect(await (await send(run, "run-1")).json()).toMatchObject({ findings: 0 });
    expect(await stored()).toBe(0);
    const search = await call("/api/search?q=", { headers: me.auth });
    expect(await search.json()).toMatchObject({ findings: null });
  });

  it("stop once switched off, and a later hosted run does not switch them back on", async () => {
    const me = await signIn(1, "me");
    const run = await hostedRun(me.account.id);
    await startHostedFindings(db, me.account.id);
    await send(run, "run-1");
    const off = await call("/api/account/sharing/hosted", {
      method: "PUT",
      headers: { ...me.auth, ...JSON_TYPE, origin: "https://ocra.test" },
      body: JSON.stringify({ enabled: false, deleteExisting: true }),
    });
    expect(await off.json()).toEqual({ hostedFindings: false, deleted: 1 });
    expect(await stored()).toBe(0);
    await startHostedFindings(db, me.account.id);
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, me.account.id));
    expect(account?.hostedFindings).toBe(false);
    expect(await (await send(run, "run-2")).json()).toMatchObject({ findings: 0 });
    expect(await sharing(me.auth)).toMatchObject({ hostedFindings: false, findingsStored: 0 });
  });
});
