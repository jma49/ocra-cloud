import { Hono } from "hono";
import { z } from "zod";
import type { FeedCursor } from "../db/notification-feed.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody, queryLimit } from "../http.js";
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

const CURSOR = /^(\d{1,15})_([\w-]{1,64})$/;

const cursorOf = (c: FeedCursor) => `${c.createdAt.getTime()}_${c.id}`;
function parseCursor(raw: string): FeedCursor | null {
  const m = CURSOR.exec(raw);
  return m ? { createdAt: new Date(Number(m[1])), id: m[2] as string } : null;
}

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
  const raw = c.req.query("before");
  const before = raw === undefined ? undefined : parseCursor(raw);
  if (before === null) {
    return apiError(c, "invalid_body", { issues: [{ path: ["before"], message: "not a cursor" }] });
  }
  const feed = c.var.data.feed;
  const [{ rows, next }, unread] = await Promise.all([
    feed.page(queryLimit(c, FEED_PAGE), before),
    feed.unread(),
  ]);
  return c.json({
    items: rows.map(feedItemDto),
    unread,
    ...(next ? { next: cursorOf(next) } : {}),
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
