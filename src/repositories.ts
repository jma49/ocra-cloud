import { REPO_HASH } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import { RETENTION_DAYS } from "./db/retention.js";
import type { Scoped } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// The account's repositories. Reviews carry only a repository's hash
// (ADR-0028); the account names the ones it recognises, and the console
// shows the name wherever it shows the hash.

export const repositoriesRoute = new Hono<AppEnv>();

/** How many repositories an account may name. */
export const MAX_NAMED = 500;
const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}]+$/u, "no control characters"),
});

/** The names the account gave its repositories, by hash. */
export async function repoNames(data: Scoped): Promise<Map<string, string>> {
  return new Map((await data.find("repositories", {}, MAX_NAMED)).map((r) => [r.repoHash, r.name]));
}

repositoriesRoute.get("/", requireSession(), async (c) => {
  const since = new Date(Date.now() - RETENTION_DAYS * DAY);
  const [reviewed, named] = await Promise.all([
    c.var.data.reviewedRepos(since),
    c.var.data.find("repositories", {}, MAX_NAMED),
  ]);
  const names = new Map(named.map((r) => [r.repoHash, r.name]));
  const seen = new Set(reviewed.map((r) => r.repoHash));
  const quiet = named
    .filter((r) => !seen.has(r.repoHash))
    .map((r) => ({
      repoHash: r.repoHash,
      reviews: 0,
      findings: 0,
      openFindings: 0,
      lastReviewAt: null,
    }));
  return c.json({
    repositories: [...reviewed, ...quiet].map((r) => ({
      ...r,
      repo: r.repoHash.slice(0, 8),
      name: names.get(r.repoHash) ?? null,
    })),
  });
});

repositoriesRoute.put(
  "/:hash",
  requireSession(),
  perMinute("settings"),
  jsonBody(nameSchema),
  async (c) => {
    const hash = c.req.param("hash");
    if (!REPO_HASH.test(hash)) return apiError(c, "not_found");
    const { name } = c.req.valid("json");
    if (!(await c.var.data.nameRepo(hash, name, MAX_NAMED))) {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["name"], message: `at most ${MAX_NAMED} repositories have names` }],
      });
    }
    return c.json({ repoHash: hash, name });
  },
);

repositoriesRoute.delete("/:hash", requireSession(), async (c) => {
  const removed = await c.var.data.removeWhere("repositories", { repoHash: c.req.param("hash") });
  return c.json({ removed: removed > 0 });
});
