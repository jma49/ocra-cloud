import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  NOTIFY_EVENTS,
  type NotifyEvent,
  QUIET_EVENTS,
  type QuietHours,
  REMINDER_EVENTS,
} from "../../../src/shared/index.js";
import { clock } from "./reminders-drawer.js";

// Reminders also need their hours, which this menu does not set.
type MenuEvent = Exclude<NotifyEvent, (typeof REMINDER_EVENTS)[number]>;
const MENU_EVENTS = NOTIFY_EVENTS.filter(
  (e): e is MenuEvent => !(REMINDER_EVENTS as readonly NotifyEvent[]).includes(e),
);

const EVENT_LABEL: Record<MenuEvent, string> = {
  review_requested: "A review is asked of me",
  pull_reviewed: "My pull request is reviewed",
  pull_closed: "My pull request is merged or closed",
  checks_failed: "Pre-merge checks fail on my pull request",
  review_blocking: "ocra finds something critical in my pull request",
  merge_when_ready: "A pull request I set to merge when ready merges or stops",
  pull_commented: "Someone comments on my pull request",
  mentioned: "Someone mentions me in a pull request",
  thread_replied: "Someone replies in a review thread I started",
  pull_at_risk: "A pull request nears or misses its review target",
};

const isQuiet = (e: MenuEvent) => (QUIET_EVENTS as readonly NotifyEvent[]).includes(e);
const ALWAYS = MENU_EVENTS.filter((e) => !isQuiet(e));
const QUIET = MENU_EVENTS.filter(isQuiet);

function summary(all: NotifyEvent[]): string {
  const events = MENU_EVENTS.filter((e) => all.includes(e));
  if (events.length === 0) return "Off";
  return events.length === MENU_EVENTS.length
    ? "All events"
    : `${events.length} of ${MENU_EVENTS.length}`;
}

/** Which events of the user's own pull requests a channel hears about, one at a time. */
export function EventsMenu(props: {
  channel: string;
  events: NotifyEvent[];
  /** The channel's quiet hours, which hold comments and mentions back until they end. */
  quietHours: QuietHours | null;
  disabled: boolean;
  change: (events: NotifyEvent[]) => void;
}) {
  const on = new Set(props.events);
  const toggled = (event: NotifyEvent) =>
    NOTIFY_EVENTS.filter((e) => (e === event ? !on.has(e) : on.has(e)));
  const item = (event: MenuEvent) => (
    <MenuCheckboxItem
      key={event}
      checked={on.has(event)}
      disabled={props.disabled}
      closeOnClick={false}
      onCheckedChange={() => props.change(toggled(event))}
    >
      {EVENT_LABEL[event]}
    </MenuCheckboxItem>
  );
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="outline" size="sm" />}
        aria-label={`My pull requests' events to ${props.channel}: ${summary(props.events)}`}
      >
        {summary(props.events)}
      </MenuTrigger>
      <MenuPopup align="start">
        {ALWAYS.map(item)}
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>
            {props.quietHours
              ? `Held from ${clock(props.quietHours.start)} to ${clock(props.quietHours.end)}, sent together after`
              : "Sent at any hour: no quiet hours set"}
          </MenuGroupLabel>
          {QUIET.map(item)}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
