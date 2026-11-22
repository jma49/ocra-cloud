import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { newId, type Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { masterKeys } from "../keyring.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import {
  NOTIFY_EVENTS,
  NOTIFY_WHEN,
  type NotifyChannelAdded,
  type NotifyChannelsView,
  type NotifyChannelView,
  type NotifyTimeZoneView,
  type QuietHours,
  REMINDER_HOURS,
  type ReminderHours,
  type ReportScheduleView,
} from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { hookUrl, reviewMessage } from "./channels.js";
import { emailAddress, mailOf, sendMail } from "./email.js";
import { CONFIRM_TTL_MS, confirmToken, linkUrl, unsubscribeUrl } from "./links.js";
import { openHook, outboxOf, sealHook, send } from "./notify.js";
import { timeZoneOf } from "./reminders.js";
import { nextSlot } from "./report.js";

// The account's channels: added with their webhook or email address, which
// is stored encrypted and never answered, tested with a sample message, and
// removed. An email address first gets a link to confirm it, and nothing
// else until it is opened. The account's weekly report slot is set here
// too. Only the web session manages them.

export const notifyRoute = new Hono<AppEnv>().use(requireSession(["web"]));

const MAX_CHANNELS = 10;
/** Confirmation emails an account may send a day, so the server cannot be used to mail strangers. */
const DAILY_CONFIRMATIONS = 10;

const name = z.string().trim().min(1).max(64);
/** Each event once, in NOTIFY_EVENTS' order. */
const events = z
  .array(z.enum(NOTIFY_EVENTS))
  .max(NOTIFY_EVENTS.length)
  .transform((list) => NOTIFY_EVENTS.filter((e) => list.includes(e)));
const hour = z.number().int().min(0).max(23);
const reminderHours = z.literal(REMINDER_HOURS).nullable();
const quietHours = z
  .object({ start: hour, end: hour })
  .refine((q) => q.start !== q.end, "start and end differ")
  .nullable();
const common = {
  name,
  when: z.enum(NOTIFY_WHEN),
  digest: z.boolean().optional(),
  weekly: z.boolean().optional(),
  events: events.optional(),
  reminderHours: reminderHours.optional(),
  quietHours: quietHours.optional(),
};
const addBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["slack", "wecom"]), url: z.string().max(512), ...common }),
  z.object({ kind: z.literal("email"), address: z.string().max(320), ...common }),
]);
const changeBody = z
  .object({
    name: name.optional(),
    when: z.enum(NOTIFY_WHEN).optional(),
    digest: z.boolean().optional(),
    weekly: z.boolean().optional(),
    events: events.optional(),
    reminderHours: reminderHours.optional(),
    quietHours: quietHours.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "nothing to change");
const scheduleBody = z.object({ weekday: z.number().int().min(0).max(6), hour });
const timeZoneBody = z.object({ timeZone: z.string().trim().min(1).max(64) });

const quietOf = (q: QuietHours | null | undefined) =>
  q === undefined ? {} : { quietStart: q?.start ?? null, quietEnd: q?.end ?? null };

const channelView = (r: Row<"notifyChannels">) =>
  ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    when: r.when,
    last4: r.last4,
    confirmed: r.confirmedAt !== null,
    digest: r.digest,
    weekly: r.weekly,
    events: r.events,
    reminderHours: (REMINDER_HOURS as readonly number[]).includes(r.reminderHours ?? -1)
      ? (r.reminderHours as ReminderHours)
      : null,
    quietHours:
      r.quietStart !== null && r.quietEnd !== null
        ? { start: r.quietStart, end: r.quietEnd }
        : null,
    lastStatus: r.lastStatus,
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }) satisfies NotifyChannelView;

notifyRoute.get("/channels", async (c) => {
  const rows = await c.var.data.find("notifyChannels", {}, MAX_CHANNELS);
  return c.json({
    channels: rows.map(channelView),
    email: c.var.mailer !== undefined,
  } satisfies NotifyChannelsView);
});

/** Mails the channel a new link to confirm its address; whether it went. */
async function sendConfirmation(c: Context<AppEnv>, channelId: string, address: string) {
  const data = c.var.data;
  const mailer = c.var.mailer;
  if (!mailer || !(await data.take("email_confirmations", DAILY_CONFIRMATIONS))) return false;
  const { token, hash } = await confirmToken(data.accountId, channelId);
  if (!(await data.notify.rearm(channelId, hash, new Date(Date.now() + CONFIRM_TTL_MS)))) {
    return false;
  }
  const out = outboxOf(c);
  const link = linkUrl(out.origin, "confirm", token);
  const unsubscribe = await unsubscribeUrl(out, data.accountId, channelId);
  return sendMail(
    mailer,
    mailOf(
      {
        subject: "Confirm your address for ocra notifications",
        lines: [
          [
            "Someone signed in to ocra asked to send this address notifications about their reviews.",
          ],
          ["Open this link within a day to confirm it; until then, nothing else is sent:"],
          [{ label: "Confirm this address", url: link }],
          ["If you did not ask for this, ignore this email or unsubscribe below."],
        ],
      },
      address,
      unsubscribe,
    ),
  );
}

const refuse = (c: Context<AppEnv>, path: string, message: string) =>
  apiError(c, "invalid_body", { issues: [{ path: [path], message }] });

notifyRoute.post("/channels", perMinute("settings"), jsonBody(addBody), async (c) => {
  const body = c.req.valid("json");
  const email = body.kind === "email";
  if (email && !c.var.mailer) return refuse(c, "kind", "this server does not send email");
  const address = body.kind === "email" ? emailAddress(body.address) : hookUrl(body.kind, body.url);
  if (!address) {
    return body.kind === "email"
      ? refuse(c, "address", "not an email address")
      : refuse(c, "url", `not a ${body.kind} incoming webhook address`);
  }
  const id = newId();
  const sealed = await sealHook(c.env.MASTER_KEY, c.var.data.accountId, id, address);
  const row = {
    id,
    kind: body.kind,
    name: body.name,
    when: body.when,
    digest: body.digest ?? false,
    weekly: body.weekly ?? false,
    events: body.events ?? [],
    reminderHours: body.reminderHours ?? null,
    quietStart: body.quietHours?.start ?? null,
    quietEnd: body.quietHours?.end ?? null,
    ...sealed,
    last4: address.slice(-4),
    // A webhook address is its chat's own credential: whoever has it may post there.
    confirmedAt: email ? null : new Date(),
  };
  if (!(await c.var.data.notify.add(row, MAX_CHANNELS))) {
    return refuse(c, "kind", `the account has ${MAX_CHANNELS} channels`);
  }
  const confirmationSent = email ? await sendConfirmation(c, id, address) : undefined;
  const stored = await c.var.data.get("notifyChannels", id);
  if (!stored) return apiError(c, "not_found");
  await audit(c.var.data, "channel.added", { channel: id, kind: stored.kind });
  return c.json({
    channel: channelView(stored),
    ...(confirmationSent !== undefined ? { confirmationSent } : {}),
  } satisfies NotifyChannelAdded);
});

/** Sends an unconfirmed address a new link. */
notifyRoute.post("/channels/:id/confirm", perMinute("settings"), async (c) => {
  const channel = await c.var.data.get("notifyChannels", c.req.param("id"));
  if (channel?.kind !== "email") return apiError(c, "not_found");
  if (channel.confirmedAt) return refuse(c, "id", "the address is confirmed already");
  const address = await openHook(masterKeys(c.env), channel);
  const sent = address !== undefined && (await sendConfirmation(c, channel.id, address));
  return c.json({ confirmationSent: sent });
});

notifyRoute.patch("/channels/:id", perMinute("settings"), jsonBody(changeBody), async (c) => {
  const id = c.req.param("id");
  const b = c.req.valid("json");
  const { name: newName, when, digest, weekly, events: newEvents } = b;
  await c.var.data.batch((w) => [
    w.update("notifyChannels", id, {
      ...(newName !== undefined ? { name: newName } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(digest !== undefined ? { digest } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
      ...(newEvents !== undefined ? { events: newEvents } : {}),
      ...(b.reminderHours !== undefined ? { reminderHours: b.reminderHours } : {}),
      ...quietOf(b.quietHours),
    }),
  ]);
  const stored = await c.var.data.get("notifyChannels", id);
  if (!stored) return apiError(c, "not_found");
  await audit(c.var.data, "channel.changed", { channel: id, keys: Object.keys(b).sort() });
  return c.json({ channel: channelView(stored) });
});

notifyRoute.delete("/channels/:id", async (c) => {
  const id = c.req.param("id");
  const removed = await c.var.data.remove("notifyChannels", id);
  if (removed) {
    await c.var.data.removeWhere("notifyHeld", { channelId: id });
    await audit(c.var.data, "channel.removed", { channel: id });
  }
  return c.json({ removed });
});

/** A sample message, with numbers marked as an example, so the user sees where it lands. */
notifyRoute.post("/channels/:id/test", perMinute("settings"), async (c) => {
  const channel = await c.var.data.get("notifyChannels", c.req.param("id"));
  if (!channel) return apiError(c, "not_found");
  if (!channel.confirmedAt) return refuse(c, "id", "the address is not confirmed yet");
  const message = reviewMessage({
    pull: null,
    critical: 0,
    warning: 0,
    suggestion: 0,
    verdict: null,
    complete: true,
    titles: [{ title: "Test message from ocra: this channel is connected", file: "example" }],
    consoleUrl: new URL("/settings", c.req.url).toString(),
  });
  const ok = await send(c.var.data, outboxOf(c), channel, message);
  return c.json({ delivered: ok });
});

const scheduleView = (s: { weekday: number; hour: number }) =>
  ({ ...s, next: nextSlot(new Date(), s).toISOString() }) satisfies ReportScheduleView;

/** When the weekly report goes, to the channels set to take it. */
notifyRoute.get("/report", async (c) => {
  return c.json(scheduleView(await c.var.data.reports.schedule()));
});

notifyRoute.put("/report", perMinute("settings"), jsonBody(scheduleBody), async (c) => {
  const { weekday, hour } = c.req.valid("json");
  await c.var.data.reports.setSchedule({ weekday, hour });
  return c.json(scheduleView({ weekday, hour }));
});

/** The account's time zone, which its channels' quiet hours are read in. */
notifyRoute.get("/time-zone", async (c) => {
  return c.json({ timeZone: await c.var.data.notify.timeZone() } satisfies NotifyTimeZoneView);
});

notifyRoute.put("/time-zone", perMinute("settings"), jsonBody(timeZoneBody), async (c) => {
  const timeZone = timeZoneOf(c.req.valid("json").timeZone);
  if (!timeZone) return refuse(c, "timeZone", "not an IANA time zone");
  await c.var.data.notify.setTimeZone(timeZone);
  return c.json({ timeZone } satisfies NotifyTimeZoneView);
});
