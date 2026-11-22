import { Hono } from "hono";
import { z } from "zod";
import { newId, type Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { masterKeys } from "../keyring.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import { NOTIFY_KINDS, NOTIFY_WHEN, type NotifyChannelView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { hookUrl, messageOf } from "./channels.js";
import { sealHook, send } from "./notify.js";

// The account's chat channels: added with their webhook address, which is
// stored encrypted and never answered, tested with a sample message, and
// removed. Only the web session manages them.

export const notifyRoute = new Hono<AppEnv>().use(requireSession(["web"]));

const MAX_CHANNELS = 10;

const name = z.string().trim().min(1).max(64);
const addBody = z.object({
  kind: z.enum(NOTIFY_KINDS),
  name,
  when: z.enum(NOTIFY_WHEN),
  url: z.string().max(512),
});
const changeBody = z
  .object({ name: name.optional(), when: z.enum(NOTIFY_WHEN).optional() })
  .refine((b) => b.name !== undefined || b.when !== undefined, "nothing to change");

const channelView = (r: Row<"notifyChannels">) =>
  ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    when: r.when,
    last4: r.last4,
    lastStatus: r.lastStatus,
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }) satisfies NotifyChannelView;

notifyRoute.get("/channels", async (c) => {
  const rows = await c.var.data.find("notifyChannels", {}, MAX_CHANNELS);
  return c.json({ channels: rows.map(channelView) });
});

notifyRoute.post("/channels", perMinute("settings"), jsonBody(addBody), async (c) => {
  const body = c.req.valid("json");
  const url = hookUrl(body.kind, body.url);
  if (!url) {
    return apiError(c, "invalid_body", {
      issues: [{ path: ["url"], message: `not a ${body.kind} incoming webhook address` }],
    });
  }
  const id = newId();
  const sealed = await sealHook(c.env.MASTER_KEY, c.var.data.accountId, id, url);
  const row = {
    id,
    kind: body.kind,
    name: body.name,
    when: body.when,
    ...sealed,
    last4: url.slice(-4),
  };
  if (!(await c.var.data.notify.add(row, MAX_CHANNELS))) {
    return apiError(c, "invalid_body", {
      issues: [{ path: ["kind"], message: `the account has ${MAX_CHANNELS} channels` }],
    });
  }
  const stored = await c.var.data.get("notifyChannels", id);
  if (!stored) return apiError(c, "not_found");
  return c.json({ channel: channelView(stored) });
});

notifyRoute.patch("/channels/:id", perMinute("settings"), jsonBody(changeBody), async (c) => {
  const id = c.req.param("id");
  const { name: newName, when } = c.req.valid("json");
  await c.var.data.batch((w) => [
    w.update("notifyChannels", id, {
      ...(newName !== undefined ? { name: newName } : {}),
      ...(when !== undefined ? { when } : {}),
    }),
  ]);
  const stored = await c.var.data.get("notifyChannels", id);
  if (!stored) return apiError(c, "not_found");
  return c.json({ channel: channelView(stored) });
});

notifyRoute.delete("/channels/:id", async (c) => {
  return c.json({ removed: await c.var.data.remove("notifyChannels", c.req.param("id")) });
});

/** A sample message, with numbers marked as an example, so the user sees where it lands. */
notifyRoute.post("/channels/:id/test", perMinute("settings"), async (c) => {
  const channel = await c.var.data.get("notifyChannels", c.req.param("id"));
  if (!channel) return apiError(c, "not_found");
  const body = messageOf(channel.kind, {
    pull: null,
    critical: 0,
    warning: 0,
    suggestion: 0,
    verdict: null,
    complete: true,
    titles: [{ title: "Test message from ocra: this channel is connected", file: "example" }],
    consoleUrl: new URL("/settings", c.req.url).toString(),
  });
  const ok = await send(c.var.data, masterKeys(c.env), channel, body);
  return c.json({ delivered: ok });
});
