import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../http.js";
import { evaluatePull, heldBySpend, statusOf } from "../merge-checks/run.js";
import { byKind, reach } from "../pull-page.js";
import { pullRef } from "../pull-ref.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { PullReadinessView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { type PremergeOutcome, readinessItems, worstOf } from "./items.js";

// One answer for the pull request's page: what still stands between it and
// its merge, read live as the signed-in user (src/platforms/readiness.ts)
// and, for the pre-merge checks, from this account's own enrolled
// repository and stored review of the head. Nothing read is kept.

export const pullReadiness = new Hono<AppEnv>();

const readinessQuery = z.object(pullRef);

pullReadiness.get("/readiness", requireSession(["web"]), perMinute("platform"), async (c) => {
  const ref = readinessQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const reached = await reach(c, byKind(ref.data));
  if ("refusal" in reached) return reached.refusal;
  const { platform, token } = reached;
  const { repo, number } = ref.data;
  const [facts, enrolled] = await Promise.all([
    platform.readiness.read(token, repo, number),
    c.var.data.mergeChecks.enrolledRepo(platform.kind, platform.host, repo),
  ]);
  if (!facts) return apiError(c, "not_found");
  const base = { platform: platform.kind, repo, number, state: facts.state, head: facts.head };
  if (facts.state !== "open") {
    return c.json({
      ...base,
      ready: null,
      items: [],
      codeOwners: [],
      staleApprovals: [],
      otherRules: [],
      canUpdateBranch: false,
    } satisfies PullReadinessView);
  }
  let premerge: PremergeOutcome = "none";
  if (enrolled) {
    const evaluated = await evaluatePull(
      c.var.data,
      platform,
      token,
      enrolled,
      number,
      facts.facts,
    );
    const held = evaluated.report && (await heldBySpend(c.var.data, evaluated.report));
    premerge = evaluated.report
      ? { report: evaluated.report, title: statusOf(evaluated.report, "", held).title }
      : evaluated.reason === "unreachable"
        ? "unreachable"
        : "none";
  }
  const { items, groups } = readinessItems(facts, platform.kind, premerge);
  return c.json({
    ...base,
    ready: worstOf(items.map((i) => i.state)),
    items: items.map((i) => ({ kind: i.kind, state: i.state, detail: i.detail })),
    codeOwners: groups.map((g) => ({
      owners: g.owners,
      files: g.files,
      state: g.state,
      approvedBy: g.approvedBy,
      required: g.required,
    })),
    staleApprovals: facts.reviews.approvals.filter((a) => !a.atHead).map((a) => a.login),
    otherRules: facts.otherRules,
    canUpdateBranch: facts.behind === true && facts.conflicts !== true,
  } satisfies PullReadinessView);
});
