import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { pullRef } from "../pull-ref.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { MergeCheckView, PullChecksView, RepoChecksView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { checksOf, evaluatePull, MAX_CHECKS } from "./run.js";
import { addCheckBody, changeCheckBody, settingsOf } from "./settings.js";

// An enrolled repository's pre-merge checks, which only the web session
// manages, and a pull request's result for its page, evaluated live as the
// signed-in user (on any host: posting it needs the bot, src/node/).

export const mergeChecksRoute = new Hono<AppEnv>().use(requireSession(["web"]));
export const pullChecksRoute = new Hono<AppEnv>().use(requireSession(["web"]));

const checkView = (r: Row<"mergeChecks">) =>
  ({
    id: r.id,
    kind: r.kind,
    mode: r.mode,
    // Read back through the kind's schema (which pairs it with its kind, past
    // what the type checker follows): a row that no longer fits shows none.
    settings: settingsOf(r.kind, r.settings) ?? {},
    createdAt: r.createdAt.toISOString(),
  }) as MergeCheckView;

const settingsRefused = (c: Context<AppEnv>) =>
  apiError(c, "invalid_body", {
    issues: [{ path: ["settings"], message: "not this kind's settings" }],
  });

mergeChecksRoute.get("/repos/:id/checks", async (c) => {
  const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
  if (!repo) return apiError(c, "not_found");
  return c.json({
    checks: (await checksOf(c.var.data, repo.id)).map(checkView),
    holdUnreviewed: repo.holdUnreviewed,
  } satisfies RepoChecksView);
});

const repoChecksBody = z.object({ holdUnreviewed: z.boolean() });

mergeChecksRoute.patch("/repos/:id", perMinute("settings"), jsonBody(repoChecksBody), async (c) => {
  const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
  if (!repo) return apiError(c, "not_found");
  const { holdUnreviewed } = c.req.valid("json");
  await c.var.data.update("reviewRepos", repo.id, { holdUnreviewed });
  return c.json({ holdUnreviewed });
});

mergeChecksRoute.post(
  "/repos/:id/checks",
  perMinute("settings"),
  jsonBody(addCheckBody),
  async (c) => {
    const body = c.req.valid("json");
    const settings = settingsOf(body.kind, body.settings);
    if (!settings) return settingsRefused(c);
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    if (!repo) return apiError(c, "not_found");
    const id = await c.var.data.mergeChecks.add(
      repo.id,
      { kind: body.kind, mode: body.mode, settings },
      MAX_CHECKS,
    );
    if (!id) {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["kind"], message: `the repository has ${MAX_CHECKS} checks` }],
      });
    }
    const stored = await c.var.data.get("mergeChecks", id);
    if (!stored) return apiError(c, "not_found");
    return c.json({ check: checkView(stored) });
  },
);

mergeChecksRoute.patch(
  "/repos/:id/checks/:check",
  perMinute("settings"),
  jsonBody(changeCheckBody),
  async (c) => {
    const { mode, settings } = c.req.valid("json");
    const check = await c.var.data.findOne("mergeChecks", {
      id: c.req.param("check"),
      reviewRepoId: c.req.param("id"),
    });
    if (!check) return apiError(c, "not_found");
    const parsed = settings === undefined ? undefined : settingsOf(check.kind, settings);
    if (settings !== undefined && !parsed) return settingsRefused(c);
    await c.var.data.update("mergeChecks", check.id, {
      ...(mode !== undefined ? { mode } : {}),
      ...(parsed !== undefined ? { settings: parsed as Record<string, unknown> } : {}),
    });
    const stored = await c.var.data.get("mergeChecks", check.id);
    if (!stored) return apiError(c, "not_found");
    return c.json({ check: checkView(stored) });
  },
);

mergeChecksRoute.delete("/repos/:id/checks/:check", async (c) => {
  const check = await c.var.data.findOne("mergeChecks", {
    id: c.req.param("check"),
    reviewRepoId: c.req.param("id"),
  });
  return c.json({ removed: check ? await c.var.data.remove("mergeChecks", check.id) : false });
});

const pullQuery = z.object(pullRef);

pullChecksRoute.get("/", perMinute("platform"), async (c) => {
  const ref = pullQuery.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const { platform: kind, repo: fullName, number } = ref.data;
  const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === kind);
  if (!platform) return apiError(c, "not_found");
  const repo = await c.var.data.mergeChecks.enrolledRepo(kind, platform.host, fullName);
  if (!repo) return c.json({ report: null, postedAt: null } satisfies PullChecksView);
  const token = await accessToken(c.var.data, c.env, platform);
  if (!token) return apiError(c, "github_user");
  const evaluated = await evaluatePull(c.var.data, platform, token, repo, number);
  if (!evaluated.report) {
    if (evaluated.reason === "unreachable") return apiError(c, "not_found");
    return c.json({ report: null, postedAt: null } satisfies PullChecksView);
  }
  const run = await c.var.data.findOne("mergeCheckRuns", {
    reviewRepoId: repo.id,
    number,
    head: evaluated.report.head,
  });
  return c.json({
    report: evaluated.report,
    postedAt: run?.postedAt?.toISOString() ?? null,
  } satisfies PullChecksView);
});
