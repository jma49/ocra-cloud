import { Hono } from "hono";
import { z } from "zod";
import type { SeenMark, SeenPull } from "./db/pull-seen.js";
import { jsonBody } from "./http.js";
import { pullRef, sha } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import { MAX_SEEN_BULK, type PullSeenBulkRequest, type PullSeenMark } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// The inbox's read marks: the pull request page marks its pull request read
// as of the updated_at and head it read, and the inbox marks a list read or
// unread. A mark never moves to an older updated_at (src/db/pull-seen.ts).

export const pullSeenRoute = new Hono<AppEnv>();

/** A platform clock this far ahead of ours is still taken. */
const SKEW_MS = 5 * 60 * 1000;

const updatedAt = z.iso
  .datetime({ offset: true })
  .refine((at) => Date.parse(at) <= Date.now() + SKEW_MS, "updatedAt is in the future");
const ref = z.object(pullRef);
const mark = ref.extend({ updatedAt, head: sha.nullable() });

const bulkBody = z.discriminatedUnion("read", [
  z.object({ read: z.literal(true), pulls: z.array(mark).min(1).max(MAX_SEEN_BULK) }),
  z.object({ read: z.literal(false), pulls: z.array(ref).min(1).max(MAX_SEEN_BULK) }),
]);

const pullOf = (p: z.output<typeof ref>): SeenPull => ({
  platform: p.platform,
  repo: p.repo.toLowerCase(),
  number: p.number,
});
const markOf = (p: PullSeenMark): SeenMark => ({
  ...pullOf(p),
  updatedAt: new Date(p.updatedAt),
  head: p.head,
});

/** One row per pull request, the last named winning: an upsert may touch a row once. */
function unique<T extends SeenPull>(list: readonly T[]): T[] {
  return [...new Map(list.map((p) => [`${p.platform}:${p.repo}#${p.number}`, p])).values()];
}

pullSeenRoute.post("/seen", requireSession(), perMinute("settings"), jsonBody(mark), async (c) => {
  const changed = await c.var.data.pullSeen.read([markOf(c.req.valid("json"))]);
  return c.json({ changed });
});

pullSeenRoute.post(
  "/seen/bulk",
  requireSession(),
  perMinute("settings"),
  jsonBody(bulkBody, { max: 128 * 1024 }),
  async (c) => {
    const body: PullSeenBulkRequest = c.req.valid("json");
    const changed = body.read
      ? await c.var.data.pullSeen.read(unique(body.pulls.map(markOf)))
      : await c.var.data.pullSeen.unread(unique(body.pulls.map(pullOf)));
    return c.json({ changed });
  },
);
