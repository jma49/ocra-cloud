import { beforeEach, describe, expect, it } from "vitest";
import { upsertAccount } from "../src/db/accounts.js";
import { scoped } from "../src/db/scoped.js";
import { instanceAdminsOf } from "../src/instance-admins.js";
import { startWebSession } from "../src/session.js";
import { INSTANCE_QUEUES, type InstanceStatus } from "../src/shared/index.js";
import { call, db, resetDb, signIn } from "./helpers.js";

// GET /api/admin/instance: the deployment's operators read counts and
// health across every account; anyone else is answered as if the route did
// not exist, and the answer names no account, repository or login.

const ADMIN = "/api/admin/instance";

beforeEach(resetDb);

const read = (auth: Record<string, string>, admins?: string) =>
  call(ADMIN, { auth }, admins === undefined ? {} : { INSTANCE_ADMINS: admins });

async function signInOidc(subject: string, login: string) {
  const account = await upsertAccount(db, { provider: "oidc", subject }, login);
  const token = await startWebSession(db, account.id);
  return { account, auth: { authorization: `Bearer ${token}` } };
}

describe("INSTANCE_ADMINS", () => {
  it("reads github: ids and oidc: subjects, none when unset", () => {
    expect(instanceAdminsOf(undefined)).toEqual([]);
    expect(instanceAdminsOf(" ")).toEqual([]);
    expect(instanceAdminsOf("github:583231, OIDC: 00u1ab|corp ,")).toEqual([
      { provider: "github", subject: "583231" },
      { provider: "oidc", subject: "00u1ab|corp" },
    ]);
  });

  it("refuses logins, other kinds and malformed ids", () => {
    for (const bad of [
      "octocat",
      "user:octocat",
      "github:octocat",
      "github:0",
      "github:-1",
      "oidc:",
      "org:x",
    ]) {
      expect(() => instanceAdminsOf(bad)).toThrow("INSTANCE_ADMINS:");
    }
    expect(() => instanceAdminsOf(Array(51).fill("github:1").join(","))).toThrow(
      "more than 50 entries",
    );
  });
});

describe("GET /api/admin/instance", () => {
  it("answers not_found to everyone while INSTANCE_ADMINS is unset", async () => {
    const me = await signIn(1, "octo");
    const res = await read(me.auth);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers not_found to an account the list does not name, by identity not login", async () => {
    const other = await signIn(2, "583231");
    const oidc = await signInOidc("583231", "octo");
    for (const auth of [other.auth, oidc.auth]) {
      const res = await read(auth, "github:583231");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("answers an operator signed in through GitHub or OpenID Connect", async () => {
    const gh = await signIn(583231, "octo");
    const oidc = await signInOidc("sub-9", "ops");
    for (const auth of [gh.auth, oidc.auth]) {
      const res = await read(auth, "github:583231,oidc:sub-9");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("counts across accounts and names none of them", async () => {
    const admin = await signIn(7, "operator");
    const tenant = await signIn(8, "secret-login");
    const jobs = scoped(db, tenant.account.id).autoReview;
    const repo = await jobs.enroll(
      {
        platform: "github",
        host: "github.com",
        platformRepoId: "11",
        fullName: "Acme/Secret-Repo",
      },
      100,
    );
    await jobs.queue(repo ?? "", 7, "c".repeat(40), new Date(Date.now() - 120_000));

    const res = await read(admin.auth, "github:7");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as InstanceStatus;
    expect(Object.keys(body).sort()).toEqual(
      [
        "accounts",
        "checkedAt",
        "deliveries",
        "engine",
        "enrolledRepos",
        "jobs",
        "runners",
        "schema",
      ].sort(),
    );
    expect(body.accounts).toBe(2);
    expect(body.enrolledRepos).toBe(1);
    expect(Object.keys(body.jobs).sort()).toEqual([...INSTANCE_QUEUES].sort());
    expect(body.jobs.review.queued).toBe(1);
    expect(body.jobs.review.oldestQueuedSeconds).toBeGreaterThanOrEqual(119);
    expect(body.jobs.reply).toEqual({
      queued: 0,
      running: 0,
      failedLast24h: 0,
      oldestQueuedSeconds: 0,
    });
    expect(body.engine.cli).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.schema.missing).toBe(0);
    expect(body.runners).toEqual({ lastSeenAt: null, stale: false });
    for (const secret of [
      "secret-login",
      "operator",
      "Secret-Repo",
      "Acme",
      tenant.account.id,
      admin.account.id,
      repo ?? "-",
      "c".repeat(40),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
