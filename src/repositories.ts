import { REPO_HASH } from "@open-cr-agent/cloud-contract";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import type { Scoped } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { repoOfIdentity } from "./review-pull.js";
import { requireSession } from "./session.js";
import { DAY } from "./time.js";
import type { AppEnv } from "./types.js";

// The account's repositories. Reviews carry a repository's hash (ADR-0028),
// and a pull request review also its host and path (ADR-0038). The console
// shows that path, or a name the account gave, wherever it shows the hash.

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

/** Where pull request reviews say each repository is, by hash. */
async function pulledAt(data: Scoped): Promise<Map<string, { host: string; repo: string }>> {
  const pulled = await data.pulledRepos();
  return new Map(
    pulled.flatMap((p) => {
      const at = p.prRepository ? repoOfIdentity(p.prRepository) : null;
      return at ? [[p.repoHash, at] as const] : [];
    }),
  );
}

/** Each repository's name by hash: the one the account gave, else the path its pull request reviews named. */
export async function repoNames(data: Scoped): Promise<Map<string, string>> {
  const [named, pulled] = await Promise.all([
    data.find("repositories", {}, MAX_NAMED),
    pulledAt(data),
  ]);
  const names = new Map([...pulled].map(([hash, at]) => [hash, at.repo]));
  for (const r of named) names.set(r.repoHash, r.name);
  return names;
}

repositoriesRoute.get("/", requireSession(), async (c) => {
  const since = new Date(Date.now() - config(c.env).retentionDays * DAY);
  const [reviewed, named, pulled] = await Promise.all([
    c.var.data.reviewedRepos(since),
    c.var.data.find("repositories", {}, MAX_NAMED),
    pulledAt(c.var.data),
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
      pulledFrom: pulled.get(r.repoHash) ?? null,
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
