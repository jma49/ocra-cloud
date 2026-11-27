import { Hono } from "hono";
import { z } from "zod";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody, queryLimit } from "../http.js";
import { encodePageCursor, optionalPageCursor } from "../page-cursor.js";
import { requireSession } from "../session.js";
import {
  FEED_PAGE,
  type FeedItemView,
  type FeedPageView,
  type FeedUnreadView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";

// The console's notification centre (./feed.ts): the account's notices,
// newest first and paged by a cursor, their unread count, which the web
// polls, and read marks. Only the web session reads them.

export const feedRoute = new Hono<AppEnv>().use(requireSession(["web"]));

const feedItemDto = (r: Row<"notificationFeed">): FeedItemView => ({
  id: r.id,
  kind: r.kind,
  at: r.createdAt.toISOString(),
  read: r.readAt !== null,
  title: r.title,
  ...(r.subtitle !== null ? { subtitle: r.subtitle } : {}),
  link: r.link,
  ...(r.repo !== null ? { repo: r.repo } : {}),
  ...(r.number !== null ? { pull: r.number } : {}),
});

feedRoute.get("/", async (c) => {
  const before = optionalPageCursor.safeParse(c.req.query("before"));
  if (!before.success) {
    return apiError(c, "invalid_body", { issues: [{ path: ["before"], message: "not a cursor" }] });
  }
  const feed = c.var.data.feed;
  const [{ rows, next }, unread] = await Promise.all([
    feed.page(queryLimit(c, FEED_PAGE), before.data),
    feed.unread(),
  ]);
  return c.json({
    items: rows.map(feedItemDto),
    unread,
    ...(next ? { next: encodePageCursor(next) } : {}),
  } satisfies FeedPageView);
});

feedRoute.get("/unread", async (c) =>
  c.json({ unread: await c.var.data.feed.unread() } satisfies FeedUnreadView),
);

const readBody = z.union([
  z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(FEED_PAGE) }),
  z.strictObject({ before: z.iso.datetime({ offset: true }).transform((v) => new Date(v)) }),
]);

feedRoute.post("/read", jsonBody(readBody), async (c) => {
  const feed = c.var.data.feed;
  await feed.markRead(c.req.valid("json"));
  return c.json({ unread: await feed.unread() } satisfies FeedUnreadView);
});
