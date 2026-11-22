import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { NOTIFY_EVENTS, type NotifyEvent } from "../../../src/shared/index.js";

const EVENT_LABEL: Record<NotifyEvent, string> = {
  review_requested: "A review is asked of me",
  pull_reviewed: "My pull request is reviewed",
  pull_closed: "My pull request is merged or closed",
  checks_failed: "Pre-merge checks fail on my pull request",
  review_blocking: "ocra finds something critical in my pull request",
  merge_when_ready: "A pull request I set to merge when ready merges or stops",
  review_waiting: "Remind me of a review still asked of me",
  pull_waiting: "Remind me of my pull request no one has reviewed",
};

function summary(events: NotifyEvent[]): string {
  if (events.length === 0) return "Off";
  return events.length === NOTIFY_EVENTS.length
    ? "All events"
    : `${events.length} of ${NOTIFY_EVENTS.length}`;
}

/** Which events of the user's own pull requests a channel hears about, one at a time. */
export function EventsMenu(props: {
  channel: string;
  events: NotifyEvent[];
  disabled: boolean;
  change: (events: NotifyEvent[]) => void;
}) {
  const on = new Set(props.events);
  const toggled = (event: NotifyEvent) =>
    NOTIFY_EVENTS.filter((e) => (e === event ? !on.has(e) : on.has(e)));
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="outline" size="sm" />}
        aria-label={`My pull requests' events to ${props.channel}: ${summary(props.events)}`}
      >
        {summary(props.events)}
      </MenuTrigger>
      <MenuPopup align="start">
        {NOTIFY_EVENTS.map((event) => (
          <MenuCheckboxItem
            key={event}
            checked={on.has(event)}
            disabled={props.disabled}
            closeOnClick={false}
            onCheckedChange={() => props.change(toggled(event))}
          >
            {EVENT_LABEL[event]}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
