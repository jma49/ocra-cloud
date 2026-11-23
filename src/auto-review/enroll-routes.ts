import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  type AutoEnrollInstallationsView,
  type AutoEnrollInstallationView,
  type AutoReviewRepoView,
  type BulkEnrollResult,
  type BulkEnrollView,
  MAX_BULK_ENROLL,
  MAX_BULK_ENROLL_GITLAB,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { enrollRepo } from "./enroll.js";
import { enrollGitlabProject } from "./enroll-gitlab.js";
import { gitlabHookUrl } from "./hook-routes.js";

// Enrolling many repositories of the user's GitHub App installations, or
// GitLab projects, at once, each read as the user as one enrollment is, a
// GitLab project's hook added as at one enrollment; and the switch that
// enrolls the repositories later added to an installation
// (./auto-enroll.ts).

const githubName = z
  .string()
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo")
  .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "owner/repo");

// group/subgroup/project on GitLab.
const gitlabName = z
  .string()
  .max(400)
  .regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "a project path")
  .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "a project path");

const bulkBody = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("github"),
    fullNames: z.array(githubName).min(1).max(MAX_BULK_ENROLL),
    // Off unless asked for: every pull request reviewed is the account's spend.
    automatic: z.boolean().default(false),
  }),
  z.object({
    platform: z.literal("gitlab"),
    fullNames: z.array(gitlabName).min(1).max(MAX_BULK_ENROLL_GITLAB),
    automatic: z.boolean().default(false),
  }),
]);

// GitHub unless named, as before GitLab could be enrolled in bulk.
const bulkInput = z.preprocess(
  (v) =>
    v && typeof v === "object" && !Array.isArray(v) && !("platform" in v)
      ? { ...v, platform: "github" }
      : v,
  bulkBody,
);

const switchBody = z.object({
  enabled: z.boolean(),
  automatic: z.boolean().default(false),
});

const INSTALLATION_ID = /^\d{1,20}$/;

type RepoView = (r: Row<"reviewRepos">, latest: undefined) => AutoReviewRepoView;

const installationView = (
  id: string,
  owner: string,
  row: Row<"autoEnrollInstallations"> | undefined,
) =>
  ({
    id,
    owner,
    enabled: row !== undefined,
    automatic: row?.automatic ?? false,
  }) satisfies AutoEnrollInstallationView;

export function enrollRoute(repoView: RepoView) {
  const route = new Hono<AppEnv>();

  route.post(
    "/repos/bulk",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(bulkInput),
    async (c) => {
      const body = c.req.valid("json");
      const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === body.platform);
      if (!platform) return apiError(c, "not_found");
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return apiError(c, "github_user");
      const names = body.fullNames.filter(
        (n, i) => body.fullNames.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i,
      );
      const scope = { data: c.var.data, bots: c.var.bots, hookUrl: gitlabHookUrl(c.req.url) };
      const results: BulkEnrollResult[] = [];
      // One after another: each repository's reads (and a GitLab project's
      // hook), within the request's calls.
      for (const fullName of names) {
        const enrolled: Awaited<ReturnType<typeof enrollGitlabProject>> =
          body.platform === "gitlab"
            ? await enrollGitlabProject(scope, platform, token, fullName, body.automatic)
            : await enrollRepo(c.var.data, platform, token, fullName, {
                automatic: body.automatic,
              });
        results.push(
          enrolled.outcome === "refused"
            ? { fullName, outcome: "refused", reason: enrolled.reason }
            : {
                fullName,
                outcome: enrolled.outcome,
                repo: repoView(enrolled.repo, undefined),
                ...(enrolled.webhook ? { webhook: enrolled.webhook } : {}),
              },
        );
      }
      return c.json({ results } satisfies BulkEnrollView);
    },
  );

  route.get("/installations", requireSession(), async (c) => {
    const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === "github");
    if (!platform?.installations) return apiError(c, "not_found");
    const token = await accessToken(c.var.data, c.env, platform);
    if (!token) return apiError(c, "github_user");
    const listed = await platform.installations(token);
    if (!listed) return apiError(c, "github_user");
    const rows = await c.var.data.find("autoEnrollInstallations", { host: platform.host }, 100);
    const byId = new Map(rows.map((r) => [r.installationId, r]));
    return c.json({
      installations: listed.installations.map((i) =>
        installationView(i.id, i.owner, byId.get(i.id)),
      ),
      more: listed.more,
    } satisfies AutoEnrollInstallationsView);
  });

  route.put(
    "/installations/:id/auto-enroll",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(switchBody),
    async (c) => {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === "github");
      if (!INSTALLATION_ID.test(id) || !platform?.installations) return apiError(c, "not_found");
      const where = { host: platform.host, installationId: id };
      if (!body.enabled) {
        const row = await c.var.data.findOne("autoEnrollInstallations", where);
        if (row && (await c.var.data.removeWhere("autoEnrollInstallations", where))) {
          await audit(c.var.data, "auto_review.auto_enroll_changed", {
            owner: row.owner,
            enabled: false,
            automatic: row.automatic,
          });
        }
        return c.json(installationView(id, row?.owner ?? "", undefined));
      }
      // Only an installation the user reaches: GitHub lists it to their token.
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return apiError(c, "github_user");
      const listed = await platform.installations(token);
      if (!listed) return apiError(c, "github_user");
      const installation = listed.installations.find((i) => i.id === id);
      if (!installation) return apiError(c, "not_found");
      const kept = await c.var.data.autoEnroll.optIn({
        ...where,
        owner: installation.owner,
        automatic: body.automatic,
      });
      if (!kept) {
        return apiError(c, "invalid_body", {
          issues: [
            {
              path: ["enabled"],
              message: "another account enrolls this installation's repositories",
            },
          ],
        });
      }
      await audit(c.var.data, "auto_review.auto_enroll_changed", {
        owner: installation.owner,
        enabled: true,
        automatic: body.automatic,
      });
      const row = await c.var.data.findOne("autoEnrollInstallations", where);
      return c.json(installationView(id, installation.owner, row));
    },
  );

  return route;
}
