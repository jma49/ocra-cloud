import { Hono } from "hono";
import { z } from "zod";
import type { Row } from "./db/scoped.js";
import { apiError, jsonBody } from "./http.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { DEFAULT_PULL_VIEWS, type PullView, type PullViewsAnswer } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The account's own sections of its pull request inbox: each a named set of
// filters over the pulls the inbox lists (./platform-routes.ts), ordered,
// renamed, hidden or removed by the account. An account without any is shown
// DEFAULT_PULL_VIEWS, which it keeps to change them.

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
    roles: some(z.enum(["reviewer", "author", "assignee"])),
    authoredBy: z.enum(["me", "others"]).optional(),
    states: some(z.enum(["open", "merged"])),
    drafts: z.enum(["include", "exclude", "only"]).optional(),
    repos: some(text),
    authors: some(text.max(100)),
    checks: some(z.enum(["passing", "failing", "pending"])),
    reviews: some(z.enum(["approved", "changes_requested", "required", "none"])),
    verdicts: some(z.enum(["blocking", "not_blocking", "unreviewed"])),
    labels: some(text.max(100)),
    updatedWithinDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
const name = text.max(60);
const viewSchema = z.object({ name, filters: filtersSchema }).strict();
const changeSchema = z
  .object({
    name: name.optional(),
    filters: filtersSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(MAX_VIEWS) }).strict();

export const viewDto = (r: Row<"pullViews">) =>
  ({
    id: r.id,
    name: r.name,
    filters: r.filters,
    position: r.position,
    hidden: r.hidden,
  }) satisfies PullView;

const byPosition = (a: Row<"pullViews">, b: Row<"pullViews">) =>
  a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime();

/** The account's views in their order. */
export async function viewsOf(data: AppEnv["Variables"]["data"]): Promise<Row<"pullViews">[]> {
  return (await data.find("pullViews", {}, MAX_VIEWS)).sort(byPosition);
}

const nameTaken = { issues: [{ path: ["name"], message: "another section has this name" }] };

pullViewsRoute.get("/", requireSession(), async (c) => {
  const views = (await viewsOf(c.var.data)).map(viewDto);
  return c.json({
    views,
    defaults: views.length === 0 ? [...DEFAULT_PULL_VIEWS] : [],
  } satisfies PullViewsAnswer);
});

pullViewsRoute.post(
  "/",
  requireSession(),
  perMinute("settings"),
  jsonBody(viewSchema),
  async (c) => {
    const added = await c.var.data.pullViews.add(c.req.valid("json"), MAX_VIEWS);
    if ("refused" in added) {
      return apiError(
        c,
        "invalid_body",
        added.refused === "taken"
          ? nameTaken
          : { issues: [{ path: [], message: `at most ${MAX_VIEWS} sections` }] },
      );
    }
    const row = await c.var.data.findOne("pullViews", { id: added.id });
    return row ? c.json(viewDto(row), 201) : apiError(c, "not_found");
  },
);

// Keeps the defaults as the account's own views, so it can change them; a
// no-op once it has any.
pullViewsRoute.post("/defaults", requireSession(), perMinute("settings"), async (c) => {
  await c.var.data.pullViews.keepDefaults(DEFAULT_PULL_VIEWS);
  return c.json({ views: (await viewsOf(c.var.data)).map(viewDto) });
});

// Puts the account's views in this order: ids names each of them once.
pullViewsRoute.put(
  "/order",
  requireSession(),
  perMinute("settings"),
  jsonBody(orderSchema),
  async (c) => {
    const { ids } = c.req.valid("json");
    const stored = await viewsOf(c.var.data);
    const known = new Set(stored.map((v) => v.id));
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== known.size ||
      ids.some((id) => !known.has(id))
    ) {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["ids"], message: "name each of the account's sections once" }],
      });
    }
    await c.var.data.batch((w) =>
      ids.map((id, position) => w.update("pullViews", id, { position })),
    );
    return c.json({ views: (await viewsOf(c.var.data)).map(viewDto) });
  },
);

pullViewsRoute.put(
  "/:id",
  requireSession(),
  perMinute("settings"),
  jsonBody(changeSchema),
  async (c) => {
    const id = c.req.param("id");
    const { name, filters, position, hidden } = c.req.valid("json");
    const changes = {
      ...(name === undefined ? {} : { name }),
      ...(filters === undefined ? {} : { filters }),
      ...(position === undefined ? {} : { position }),
      ...(hidden === undefined ? {} : { hidden }),
    };
    if (Object.keys(changes).length > 0) {
      const changed = await c.var.data.pullViews.change(id, changes);
      if (changed === "not_found") return apiError(c, "not_found");
      if (changed === "taken") return apiError(c, "invalid_body", nameTaken);
    }
    const row = await c.var.data.findOne("pullViews", { id });
    return row ? c.json(viewDto(row)) : apiError(c, "not_found");
  },
);

pullViewsRoute.delete("/:id", requireSession(), async (c) => {
  const removed = await c.var.data.removeWhere("pullViews", { id: c.req.param("id") });
  return removed > 0 ? c.json({ removed: true }) : apiError(c, "not_found");
});
