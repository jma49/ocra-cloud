import {
  liveBatchSchema,
  MAX_LIVE_BATCH_BYTES,
  type ReviewEvent,
  readReviewEvent,
} from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { loginOf } from "../db/accounts.js";
import { accountByLogin, type LiveDoor, liveAccess, sharedWithMe } from "../db/live-access.js";
import { type Row, type Scoped, scoped } from "../db/scoped.js";
import { keepsFindings } from "../findings-kept.js";
import { apiError, jsonBody } from "../http.js";
import { perMinute } from "../rate.js";
import { repoNames } from "../repositories.js";
import { requireSession } from "../session.js";
import {
  LIVE_ROLES,
  type LiveShareView,
  MAX_LIVE_COMMENT,
  MAX_LIVE_PEOPLE,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { linkCheck, linkUrl, newNonce } from "./link.js";
import { liveStream, readerSeq } from "./stream.js";
import { liveCommentDto, liveRunDto, type OwnerNames, pullOf } from "./views.js";

// Reviews watched while they run, and shared (ADR-0056): the CLI's batches
// come in at POST /api/live; the rest is the console's.

export const liveRoute = new Hono<AppEnv>();

const MAX_RUNS = 50;

/** The owner's names for the runs' repositories and titles for their pull requests. */
async function ownerNames(data: Scoped, runs: readonly Row<"liveRuns">[]): Promise<OwnerNames> {
  const pulls = runs.flatMap((r) => pullOf(r) ?? []);
  const [repos, titles] = await Promise.all([repoNames(data), data.pullFlows.titles(pulls)]);
  return { repos, titles };
}
const MAX_COMMENTS = 500;
const PAGE = 1_000;

const origin = (c: Context<AppEnv>) => c.env.PUBLIC_URL ?? new URL(c.req.url).origin;
const watchUrl = (c: Context<AppEnv>, id: string) => `${new URL(origin(c)).origin}/live/${id}`;

/** The batch's events this server knows, or undefined when one of a known kind does not fit. */
function readEvents(events: readonly unknown[]): ReviewEvent[] | undefined {
  try {
    return events.map(readReviewEvent).filter((e): e is ReviewEvent => e !== undefined);
  } catch {
    return undefined;
  }
}

liveRoute.post(
  "/",
  requireSession(["cli"]),
  perMinute("live"),
  jsonBody(liveBatchSchema, { max: MAX_LIVE_BATCH_BYTES }),
  async (c) => {
    const batch = c.req.valid("json");
    // The events carry paths and finding text, kept only while the account shares findings.
    if (!(await keepsFindings(c))) return c.json({});
    const events = readEvents(batch.events);
    if (!events)
      return apiError(c, "invalid_body", {
        issues: [{ path: ["events"], message: "an event does not fit its kind" }],
      });
    const runId = batch.events[0]?.runId ?? "";
    if (events.length === 0) {
      const run = await c.var.data.live.run(runId);
      return c.json(run ? { watch: watchUrl(c, run.id) } : {});
    }
    const id = await c.var.data.live.record(runId, batch.run, events, new Date());
    return c.json(id ? { watch: watchUrl(c, id) } : {});
  },
);

liveRoute.get("/", requireSession(), async (c) => {
  const me = c.var.session.account;
  const [own, shared] = await Promise.all([
    c.var.data.live.runs(MAX_RUNS),
    sharedWithMe(c.var.db, me.id, MAX_RUNS),
  ]);
  const names = await ownerNames(c.var.data, own);
  return c.json({
    runs: own.map((r) => liveRunDto(r, me.login, "owner", names)),
    shared: shared.map((s) => liveRunDto(s.run, s.owner, s.role)),
  });
});

/** The run the request names, if the viewer may see it, read as its owner's. */
async function open(c: Context<AppEnv>): Promise<(LiveDoor & { id: string }) | undefined> {
  const id = c.req.param("id") ?? "";
  if (!/^[\w-]{1,64}$/.test(id)) return undefined;
  const check = linkCheck(c.env.SESSION_SECRET, id, c.req.query("k"));
  const door = await liveAccess(c.var.db, c.var.session.account.id, id, check);
  return door ? { ...door, id } : undefined;
}

async function shareView(c: Context<AppEnv>, id: string): Promise<LiveShareView | undefined> {
  const run = await c.var.data.live.run(id);
  if (!run) return undefined;
  const people = await c.var.data.live.grants(id);
  return {
    link:
      run.linkNonce && run.linkRole
        ? {
            role: run.linkRole,
            url: await linkUrl(origin(c), c.env.SESSION_SECRET, id, run.linkNonce),
          }
        : null,
    people: people.map((p) => ({ id: p.id, login: p.login, role: p.role })),
  };
}

liveRoute.get("/:id", requireSession(), async (c) => {
  const door = await open(c);
  if (!door) return apiError(c, "not_found");
  const owner = scoped(c.var.db, door.ownerId);
  const run = await owner.live.run(door.id);
  if (!run) return apiError(c, "not_found");
  const isOwner = door.access === "owner";
  const [login, names] = isOwner
    ? [c.var.session.account.login, await ownerNames(c.var.data, [run])]
    : [(await loginOf(c.var.db, door.ownerId)) ?? "", undefined];
  return c.json({
    run: liveRunDto(run, login, door.access, names),
    ...(isOwner ? { share: await shareView(c, door.id) } : {}),
  });
});

liveRoute.get("/:id/events", requireSession(), async (c) => {
  const door = await open(c);
  if (!door) return apiError(c, "not_found");
  const events = await scoped(c.var.db, door.ownerId).live.eventsAfter(door.id, readerSeq(c), PAGE);
  return c.json({ events });
});

liveRoute.get("/:id/stream", requireSession(), perMinute("live"), async (c) => {
  const door = await open(c);
  if (!door) return apiError(c, "not_found");
  return liveStream(c, scoped(c.var.db, door.ownerId), door.id, readerSeq(c));
});

liveRoute.get("/:id/comments", requireSession(), async (c) => {
  const door = await open(c);
  if (!door) return apiError(c, "not_found");
  const rows = await scoped(c.var.db, door.ownerId).live.comments(door.id, MAX_COMMENTS);
  const viewer = { id: c.var.session.account.id, owner: door.access === "owner" };
  return c.json({ comments: rows.map((r) => liveCommentDto(r, viewer)) });
});

const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_LIVE_COMMENT),
    findingId: z
      .string()
      .regex(/^[\w.:-]{1,128}$/)
      .nullable()
      .default(null),
  })
  .strict();

liveRoute.post(
  "/:id/comments",
  requireSession(),
  perMinute("settings"),
  jsonBody(commentSchema),
  async (c) => {
    const door = await open(c);
    if (!door) return apiError(c, "not_found");
    if (door.access === "watch") return apiError(c, "forbidden_for_session");
    const { body, findingId } = c.req.valid("json");
    const me = c.var.session.account;
    const row = await scoped(c.var.db, door.ownerId).live.comment(
      door.id,
      { id: me.id, login: me.login },
      body,
      findingId,
    );
    return c.json(liveCommentDto(row, { id: me.id, owner: door.access === "owner" }), 201);
  },
);

liveRoute.delete("/:id/comments/:commentId", requireSession(), async (c) => {
  const door = await open(c);
  if (!door) return apiError(c, "not_found");
  const by = { id: c.var.session.account.id, owner: door.access === "owner" };
  const removed = await scoped(c.var.db, door.ownerId).live.uncomment(
    door.id,
    c.req.param("commentId"),
    by,
  );
  return removed ? c.json({ removed: true }) : apiError(c, "not_found");
});

const roleSchema = z.object({ role: z.enum(LIVE_ROLES) }).strict();
const linkSchema = roleSchema.extend({ replace: z.boolean().optional() }).strict();

// Turns the link on, or changes what it allows; `replace` makes a new link and the old one stops.
liveRoute.put(
  "/:id/link",
  requireSession(),
  perMinute("settings"),
  jsonBody(linkSchema),
  async (c) => {
    const id = c.req.param("id");
    const run = await c.var.data.live.run(id);
    if (!run) return apiError(c, "not_found");
    const { role, replace } = c.req.valid("json");
    const nonce = !replace && run.linkNonce ? run.linkNonce : newNonce();
    await c.var.data.live.setLink(id, { nonce, role });
    await audit(c.var.data, "live.link_changed", { run: id, role });
    return c.json(await shareView(c, id));
  },
);

liveRoute.delete("/:id/link", requireSession(), async (c) => {
  const id = c.req.param("id");
  if (!(await c.var.data.live.setLink(id, null))) return apiError(c, "not_found");
  await audit(c.var.data, "live.link_changed", { run: id, role: null });
  return c.json(await shareView(c, id));
});

const personSchema = roleSchema.extend({ login: z.string().trim().min(1).max(100) }).strict();

liveRoute.post(
  "/:id/people",
  requireSession(),
  perMinute("settings"),
  jsonBody(personSchema),
  async (c) => {
    const id = c.req.param("id");
    if (!(await c.var.data.live.run(id))) return apiError(c, "not_found");
    const { login, role } = c.req.valid("json");
    const grantee = await accountByLogin(c.var.db, login);
    if (!grantee || grantee === c.var.session.account.id) {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["login"], message: "nobody signs in to this server under that name" }],
      });
    }
    if (!(await c.var.data.live.grant(id, grantee, role, MAX_LIVE_PEOPLE))) {
      return apiError(c, "invalid_body", {
        issues: [{ path: [], message: `at most ${MAX_LIVE_PEOPLE} people` }],
      });
    }
    await audit(c.var.data, "live.person_added", { run: id, login, role });
    return c.json(await shareView(c, id));
  },
);

liveRoute.delete("/:id/people/:grantId", requireSession(), async (c) => {
  const id = c.req.param("id");
  const revoked = await c.var.data.live.revoke(id, c.req.param("grantId"));
  if (revoked) await audit(c.var.data, "live.person_removed", { run: id });
  const view = await shareView(c, id);
  return view ? c.json(view) : apiError(c, "not_found");
});

liveRoute.delete("/:id", requireSession(), async (c) => {
  const removed = await c.var.data.remove("liveRuns", c.req.param("id"));
  return removed ? c.json({ removed: true }) : apiError(c, "not_found");
});
