import { Hono } from "hono";
import { z } from "zod";
import type { Row } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import type { PullView } from "./shared/index.js";
import type { AppEnv } from "./types.js";

export const pullViewsRoute = new Hono<AppEnv>();

const MAX_VIEWS = 20;
const MAX_VALUES = 50;

const text = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]+$/u, "no control characters");
const some = <T extends z.ZodType>(value: T) => z.array(value).min(1).max(MAX_VALUES).optional();

const filtersSchema = z
  .object({
    roles: some(z.enum(["reviewer", "author"])),
    states: some(z.enum(["open", "merged"])),
    drafts: z.enum(["include", "exclude", "only"]).optional(),
    repos: some(text),
    authors: some(text),
    checks: some(z.enum(["passing", "failing", "pending"])),
    reviews: some(z.enum(["approved", "changes_requested", "required"])),
  })
  .strict();
const viewSchema = z.object({ name: text.max(60), filters: filtersSchema }).strict();
const changeSchema = viewSchema
  .partial()
  .extend({ position: z.number().int().min(0).max(10_000).optional() })
  .strict();

const viewDto = (r: Row<"pullViews">) =>
  ({ id: r.id, name: r.name, filters: r.filters, position: r.position }) satisfies PullView;

const byPosition = (a: Row<"pullViews">, b: Row<"pullViews">) =>
  a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime();

pullViewsRoute.get("/", requireSession(), async (c) => {
  const rows = await c.var.data.find("pullViews", {}, MAX_VIEWS);
  return c.json({ views: rows.sort(byPosition).map(viewDto) });
});

pullViewsRoute.post(
  "/",
  requireSession(),
  perMinute("settings"),
  jsonBody(viewSchema),
  async (c) => {
    const id = await c.var.data.addPullView(c.req.valid("json"), MAX_VIEWS);
    if (!id) {
      return apiError(c, "invalid_body", {
        issues: [{ path: [], message: `at most ${MAX_VIEWS} sections` }],
      });
    }
    const row = await c.var.data.findOne("pullViews", { id });
    return row ? c.json(viewDto(row), 201) : apiError(c, "not_found");
  },
);

pullViewsRoute.put(
  "/:id",
  requireSession(),
  perMinute("settings"),
  jsonBody(changeSchema),
  async (c) => {
    const id = c.req.param("id");
    if (!(await c.var.data.findOne("pullViews", { id }))) return apiError(c, "not_found");
    const { name, filters, position } = c.req.valid("json");
    const changes = {
      ...(name === undefined ? {} : { name }),
      ...(filters === undefined ? {} : { filters }),
      ...(position === undefined ? {} : { position }),
    };
    if (Object.keys(changes).length > 0) {
      await c.var.data.batch((w) => [w.update("pullViews", id, changes)]);
    }
    const row = await c.var.data.findOne("pullViews", { id });
    return row ? c.json(viewDto(row)) : apiError(c, "not_found");
  },
);

pullViewsRoute.delete("/:id", requireSession(), async (c) => {
  const removed = await c.var.data.removeWhere("pullViews", { id: c.req.param("id") });
  return removed > 0 ? c.json({ removed: true }) : apiError(c, "not_found");
});
