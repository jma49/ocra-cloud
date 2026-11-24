import { MEND_LEVELS } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Row, Scoped } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  type AutoReviewMendView,
  CODE_PLATFORMS,
  MAX_DAILY_FIX_REQUESTS,
  MAX_MEND_REQUEST,
  type MendItemView,
  type MendRequestView,
  type PullMendView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { enrolledPull } from "./fix-routes.js";
import { MEND_DEBOUNCE_MS } from "./mend-round.js";
import type { AutoReviewService } from "./routes.js";

// The fix loop of a pull request (./mend-work.ts): the repository's level,
// off the bot's commits until the account sets it to `commit`; the findings
// a person asks ocra to fix there, which queue the loop's next round; and
// what the rounds did. Enrolling proved the account reaches the repository.

const levelBody = z.object({ mend: z.enum(MEND_LEVELS) });
const requestBody = z.object({
  findings: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(MAX_MEND_REQUEST)
    .refine((ids) => new Set(ids).size === ids.length, "a finding twice"),
});
const pullQuery = z.object({
  platform: z.enum(CODE_PLATFORMS),
  repo: z.string().min(1).max(400),
  number: z.coerce
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
});

const itemView = (i: Row<"mendItems">) =>
  ({
    finding: i.findingId,
    outcome: i.outcome,
    reason: i.reason,
    cause: i.cause,
    commit: i.commitSha,
    requestedAt: i.createdAt.toISOString(),
    finishedAt: i.finishedAt?.toISOString() ?? null,
  }) satisfies MendItemView;

async function pullView(data: Scoped, repo: Row<"reviewRepos">, number: number) {
  const found = await data.mends.forPull(repo.id, number);
  return {
    level: repo.mend,
    loop: found
      ? {
          // A loop is never superseded: a row in that state is one that failed.
          state: found.job.state === "superseded" ? "failed" : found.job.state,
          outcome: found.job.outcome,
          error: found.job.error,
          finishedAt: found.job.finishedAt?.toISOString() ?? null,
        }
      : null,
    items: (found?.items ?? []).map(itemView),
  } satisfies PullMendView;
}

export function mendRoute(service: AutoReviewService) {
  const route = new Hono<AppEnv>();

  route.put(
    "/repos/:id/mend",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(levelBody),
    async (c) => {
      const { mend } = c.req.valid("json");
      const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
      const changed = repo && (await c.var.data.update("reviewRepos", repo.id, { mend }));
      if (!repo || !changed) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.mend_changed", { repo: repo.fullName, mend });
      return c.json({ mend } satisfies AutoReviewMendView);
    },
  );

  route.post(
    "/mends",
    requireSession(["web"]),
    perMinute("platform"),
    jsonBody(requestBody),
    async (c) => {
      const data = c.var.data;
      const found = await Promise.all(
        c.req.valid("json").findings.map((id) => data.get("findings", id)),
      );
      const asked = found.filter((f) => f !== undefined);
      const [first] = asked;
      if (!first || asked.length < found.length) return apiError(c, "not_found");
      // One pull request a request: the findings of one review of it.
      if (asked.some((f) => f.reviewId !== first.reviewId)) return apiError(c, "not_found");
      const pull = await enrolledPull(c, first);
      if (!pull) return apiError(c, "not_found");
      const answer = async (outcome: MendRequestView["outcome"]) =>
        c.json({
          outcome,
          mend: await pullView(data, pull.repo, pull.number),
        } satisfies MendRequestView);
      if (pull.repo.mend !== "commit") return answer("not_enabled");
      // A fix is asked for what is still open and the judge kept, as `ocra fix` asks.
      const wanted = asked
        .filter((f) => f.status === "open" && !f.lowConfidence)
        .map((f) => ({ findingId: f.id, fingerprint: f.fingerprint }));
      const now = new Date();
      const { queued, limited } = await data.mends.request(
        { reviewRepoId: pull.repo.id, number: pull.number },
        wanted,
        MAX_DAILY_FIX_REQUESTS,
        new Date(now.getTime() + MEND_DEBOUNCE_MS),
        now,
      );
      if (queued === 0 && limited) {
        return apiError(c, "daily_limit", { limit: MAX_DAILY_FIX_REQUESTS });
      }
      if (queued > 0) {
        await audit(data, "pull.mend_requested", {
          pull: `${pull.repo.fullName}#${pull.number}`,
          findings: queued,
        });
        service.kick();
      }
      return answer(queued > 0 ? "queued" : "requested");
    },
  );

  route.get("/mends", requireSession(["web"]), async (c) => {
    const ref = pullQuery.safeParse(c.req.query());
    if (!ref.success) return apiError(c, "not_found");
    const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === ref.data.platform);
    const repo =
      platform &&
      (await c.var.data.findOne("reviewRepos", {
        platform: platform.kind,
        host: platform.host,
        fullName: ref.data.repo,
      }));
    if (!repo) return c.json({ level: null, loop: null, items: [] } satisfies PullMendView);
    return c.json(await pullView(c.var.data, repo, ref.data.number));
  });

  return route;
}
