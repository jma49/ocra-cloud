import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { AutoReviewRestackView, RestackHistoryView, RestackJobView } from "../shared/index.js";
import type { AppEnv } from "../types.js";

// The switch that lets the bot rebase and force-push the pull requests
// stacked on one that merged, any author's (src/stack-merge/restack.ts),
// off until the account turns it on for the repository; and what it did.

const restackBody = z.object({ restack: z.boolean() });

export const restackJobView = (j: Row<"restackJobs">) =>
  ({
    id: j.id,
    number: j.number,
    parent: j.parent,
    branch: j.branch,
    onto: j.ontoBranch,
    from: j.head,
    to: j.restackedTo,
    // Restacks are never superseded: a row in that state is one that failed.
    state: j.state === "superseded" ? "failed" : j.state,
    outcome: j.outcome,
    reason: j.error,
    askedBy: j.askedBy,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  }) satisfies RestackJobView;

export function restackRoute() {
  const route = new Hono<AppEnv>();

  route.get("/repos/:id/restacks", requireSession(), async (c) => {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const jobs = await c.var.data.restacks.forRepo(repo.id);
    return c.json({
      restack: repo.restack,
      jobs: jobs.map(restackJobView),
    } satisfies RestackHistoryView);
  });

  route.put(
    "/repos/:id/restack",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(restackBody),
    async (c) => {
      const { restack } = c.req.valid("json");
      const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
      const changed = repo && (await c.var.data.update("reviewRepos", repo.id, { restack }));
      if (!repo || !changed) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.restack_changed", { repo: repo.fullName, restack });
      return c.json({ restack } satisfies AutoReviewRestackView);
    },
  );

  return route;
}
