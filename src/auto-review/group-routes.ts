import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import {
  GROUP_PAGES,
  gitlabGroupProjects,
  gitlabMaintainedGroups,
} from "../platforms/gitlab-group-projects.js";
import { accessToken } from "../platforms/links.js";
import { platformsOf } from "../platforms/registry.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { AutoEnrollGroupsView, AutoEnrollGroupView } from "../shared/index.js";
import type { AppEnv } from "../types.js";

// The switch that enrolls a GitLab group's new projects for the account
// (./group-sweep.ts), for a group the user maintains: GitLab lists it to
// their token with the Maintainer role or above.

const switchBody = z.object({
  enabled: z.boolean(),
  // Off unless asked for: every merge request reviewed is the account's spend.
  automatic: z.boolean().default(false),
});

const GROUP_ID = /^\d{1,20}$/;

const groupView = (id: string, fullPath: string, row: Row<"autoEnrollGroups"> | undefined) =>
  ({
    id,
    fullPath,
    enabled: row !== undefined,
    automatic: row?.automatic ?? false,
  }) satisfies AutoEnrollGroupView;

export function groupRoute() {
  const route = new Hono<AppEnv>();

  route.get("/gitlab/groups", requireSession(), async (c) => {
    const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === "gitlab");
    if (!platform) return apiError(c, "not_found");
    const token = await accessToken(c.var.data, c.env, platform);
    if (!token) return apiError(c, "github_user");
    const listed = await gitlabMaintainedGroups(platform.url, token);
    if (!listed) return apiError(c, "upstream_unreachable");
    const rows = await c.var.data.find(
      "autoEnrollGroups",
      { host: platform.host },
      GROUP_PAGES * 100,
    );
    const byId = new Map(rows.map((r) => [r.groupId, r]));
    return c.json({
      groups: listed.groups.map((g) => groupView(g.id, g.fullPath, byId.get(g.id))),
      more: listed.more,
    } satisfies AutoEnrollGroupsView);
  });

  route.put(
    "/gitlab/groups/:id/auto-enroll",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(switchBody),
    async (c) => {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const platform = platformsOf(c.env, c.req.url).find((p) => p.kind === "gitlab");
      if (!GROUP_ID.test(id) || !platform) return apiError(c, "not_found");
      const where = { host: platform.host, groupId: id };
      if (!body.enabled) {
        const row = await c.var.data.findOne("autoEnrollGroups", where);
        if (row && (await c.var.data.removeWhere("autoEnrollGroups", where))) {
          await audit(c.var.data, "auto_review.auto_enroll_changed", {
            owner: row.fullPath,
            enabled: false,
            automatic: row.automatic,
          });
        }
        return c.json(groupView(id, row?.fullPath ?? "", undefined));
      }
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return apiError(c, "github_user");
      const listed = await gitlabMaintainedGroups(platform.url, token);
      if (!listed) return apiError(c, "upstream_unreachable");
      const group = listed.groups.find((g) => g.id === id);
      if (!group) return apiError(c, "not_found");
      // Its projects until now are enrolled in bulk; the sweep takes those made later.
      const newest = await gitlabGroupProjects(platform.url, token, id, 1);
      if (!newest) return apiError(c, "upstream_unreachable");
      const kept = await c.var.data.autoEnrollGroups.optIn({
        ...where,
        fullPath: group.fullPath,
        automatic: body.automatic,
        lastProjectId: newest[0]?.id ?? 0,
      });
      if (!kept) {
        return apiError(c, "invalid_body", {
          issues: [
            { path: ["enabled"], message: "another account enrolls this group's new projects" },
          ],
        });
      }
      await audit(c.var.data, "auto_review.auto_enroll_changed", {
        owner: group.fullPath,
        enabled: true,
        automatic: body.automatic,
      });
      const row = await c.var.data.findOne("autoEnrollGroups", where);
      return c.json(groupView(id, group.fullPath, row));
    },
  );

  return route;
}
