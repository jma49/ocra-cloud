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
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { enrollRepo } from "./enroll.js";

// Enrolling many repositories of the user's GitHub App installations at
// once, each read as the user as one enrollment is; and the switch that
// enrolls the repositories later added to an installation
// (./auto-enroll.ts).

const githubName = z
  .string()
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo")
  .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "owner/repo");

const bulkBody = z.object({
  fullNames: z.array(githubName).min(1).max(MAX_BULK_ENROLL),
  // Off unless asked for: every pull request reviewed is the account's spend.
  automatic: z.boolean().default(false),
});

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
    jsonBody(bulkBody),
    async (c) => {
      const body = c.req.valid("json");
      const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === "github");
      if (!platform) return apiError(c, "not_found");
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return apiError(c, "github_user");
      const names = body.fullNames.filter(
        (n, i) => body.fullNames.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i,
      );
      const results: BulkEnrollResult[] = [];
      // One after another: each repository's two reads, within the request's calls.
      for (const fullName of names) {
        const enrolled = await enrollRepo(c.var.data, platform, token, fullName, {
          automatic: body.automatic,
        });
        results.push(
          enrolled.outcome === "refused"
            ? { fullName, outcome: "refused", reason: enrolled.reason }
            : { fullName, outcome: enrolled.outcome, repo: repoView(enrolled.repo, undefined) },
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
