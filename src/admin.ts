import { Hono } from "hono";
import manifest from "../package.json" with { type: "json" };
import { hasIdentity } from "./db/accounts.js";
import { instanceStats } from "./db/instance-stats.js";
import { SCHEMA_TAG } from "./db/migrations.js";
import { RUNNER_STALE_MS } from "./health.js";
import { apiError } from "./http.js";
import { instanceAdminsOf } from "./instance-admins.js";
import { requireSession } from "./session.js";
import type { InstanceStatus } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The deployment's operators (INSTANCE_ADMINS) read its state here, read
// only: counts across every account and health, never an account's names,
// content or tokens. Anyone else is answered as if the route did not exist.

export const adminRoute = new Hono<AppEnv>().use(requireSession(["web"]));

adminRoute.get("/instance", async (c) => {
  const admins = instanceAdminsOf(c.env.INSTANCE_ADMINS);
  if (!(await hasIdentity(c.var.db, c.var.session.account.id, admins))) {
    return apiError(c, "not_found");
  }
  const now = new Date();
  const stats = await instanceStats(c.var.db, now);
  const deps = manifest.dependencies;
  const m = stats.migrations;
  const seenAt = stats.runnerSeenAt;
  const body = {
    checkedAt: now.toISOString(),
    engine: { cli: deps["@open-cr-agent/cli"], contract: deps["@open-cr-agent/cloud-contract"] },
    schema: {
      newest: SCHEMA_TAG,
      expected: m?.expected ?? null,
      applied: m?.applied ?? null,
      missing: m?.missing.length ?? null,
      unknown: m?.unknown ?? null,
    },
    accounts: stats.accounts,
    enrolledRepos: stats.enrolledRepos,
    jobs: stats.jobs,
    runners: {
      lastSeenAt: seenAt?.toISOString() ?? null,
      stale: seenAt !== undefined && now.getTime() - seenAt.getTime() > RUNNER_STALE_MS,
    },
    deliveries: { notify: stats.notify, inbound: stats.inbound },
  } satisfies InstanceStatus;
  c.header("cache-control", "no-store");
  return c.json(body);
});
