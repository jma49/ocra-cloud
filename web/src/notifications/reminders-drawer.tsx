import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type NotifyChannelView,
  type NotifyEvent,
  type NotifyTimeZoneView,
  type QuietHours,
  REMINDER_EVENTS,
  REMINDER_HOURS,
  type ReminderHours,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { useLoad } from "../ui.js";

type ReminderEvent = (typeof REMINDER_EVENTS)[number];
const EVENT_LABEL: Record<ReminderEvent, string> = {
  review_waiting: "A review asked of me is still waiting",
  pull_waiting: "My pull request has no review yet",
};
const HOURS_LABEL: Record<ReminderHours, string> = {
  4: "4 hours",
  8: "8 hours",
  24: "1 day",
  48: "2 days",
};
const HOURS = Array.from({ length: 24 }, (_, h) => h);
export const clock = (h: number) => `${String(h).padStart(2, "0")}:00`;
const DEFAULT_QUIET: QuietHours = { start: 22, end: 8 };

const isReminder = (e: NotifyEvent): e is ReminderEvent =>
  (REMINDER_EVENTS as readonly NotifyEvent[]).includes(e);

/** What the Reminders cell says of a channel: off, or after how long. */
export function reminderSummary(c: Pick<NotifyChannelView, "events" | "reminderHours">): string {
  return c.reminderHours !== null && c.events.some(isReminder)
    ? `After ${HOURS_LABEL[c.reminderHours]}`
    : "Off";
}

function zones(current: string): string[] {
  const all = Intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", current, ...all])];
}

export type ReminderChange = {
  events: NotifyEvent[];
  reminderHours: ReminderHours | null;
  quietHours: QuietHours | null;
};

/** A channel's reminders: which waits it hears of, after how long, and the hours they hold for. */
export function RemindersDrawer(props: {
  channel: NotifyChannelView;
  onSave: (change: ReminderChange) => Promise<unknown>;
  onClose: () => void;
}) {
  const { channel } = props;
  const zone = useLoad(() => api<NotifyTimeZoneView>("/notifications/time-zone"));
  const [on, setOn] = useState(() => new Set(channel.events.filter(isReminder)));
  const [hours, setHours] = useState<ReminderHours>(channel.reminderHours ?? 24);
  const [quiet, setQuiet] = useState(channel.quietHours);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stored = zone.data?.timeZone ?? "UTC";
  const shownZone = timeZone ?? stored;
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const toggle = (event: ReminderEvent) =>
    setOn((was) => {
      const next = new Set(was);
      if (!next.delete(event)) next.add(event);
      return next;
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (shownZone !== stored) {
        await api("/notifications/time-zone", {
          method: "PUT",
          body: JSON.stringify({ timeZone: shownZone }),
        });
      }
      await props.onSave({
        events: [...channel.events.filter((x) => !isReminder(x)), ...on],
        reminderHours: on.size > 0 ? hours : null,
        quietHours: quiet,
      });
      props.onClose();
    } catch (failed) {
      setError(failed);
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Reminders"
      heading={`Reminders to ${channel.name}`}
      onClose={props.onClose}
      onSubmit={submit}
      foot={
        <Button type="submit" loading={busy}>
          Save
        </Button>
      }
    >
      <p className="muted small">
        A reminder goes once a pull request has waited this long, checked every hour. It covers
        reviews asked from now on.
      </p>
      <fieldset className="view-group">
        <legend>Remind me when</legend>
        {REMINDER_EVENTS.map((event) => (
          <label key={event}>
            <input type="checkbox" checked={on.has(event)} onChange={() => toggle(event)} />{" "}
            {EVENT_LABEL[event]}
          </label>
        ))}
      </fieldset>
      <label className="field">
        After
        <select
          className="input"
          value={hours}
          disabled={on.size === 0}
          onChange={(e) => setHours(Number(e.target.value) as ReminderHours)}
        >
          {REMINDER_HOURS.map((h) => (
            <option key={h} value={h}>
              {HOURS_LABEL[h]}
            </option>
          ))}
        </select>
      </label>
      {channel.kind !== "webhook" && (
        <fieldset className="view-group">
          <legend>Quiet hours</legend>
          <label>
            <input
              type="checkbox"
              checked={quiet !== null}
              onChange={() => setQuiet(quiet ? null : DEFAULT_QUIET)}
            />{" "}
            Send no reminder, comment or mention during these hours
          </label>
          {quiet && (
            <div className="quiet-hours">
              <span>From</span>
              <select
                className="input"
                aria-label="Quiet from"
                value={quiet.start}
                onChange={(e) => setQuiet({ ...quiet, start: Number(e.target.value) })}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h} disabled={h === quiet.end}>
                    {clock(h)}
                  </option>
                ))}
              </select>
              <span>to</span>
              <select
                className="input"
                aria-label="Quiet until"
                value={quiet.end}
                onChange={(e) => setQuiet({ ...quiet, end: Number(e.target.value) })}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h} disabled={h === quiet.start}>
                    {clock(h)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
      )}
      <label className="field">
        Time zone
        <select
          className="input"
          value={shownZone}
          disabled={!zone.data}
          onChange={(e) => setTimeZone(e.target.value)}
        >
          {zones(shownZone).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        Quiet hours are read in this time zone, which every channel of the account shares.
      </p>
      {zone.data && here && here !== shownZone && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setTimeZone(here)}>
            Use {here}
          </Button>
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert">
          Could not save it: {why(error)}.
        </p>
      )}
    </Drawer>
  );
}
