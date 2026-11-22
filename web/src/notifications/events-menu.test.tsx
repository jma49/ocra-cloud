import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QuietHours } from "../../../src/shared/index.js";
import { EventsMenu } from "./events-menu.js";

afterEach(cleanup);

async function quietGroup(quietHours: QuietHours | null) {
  render(
    <EventsMenu
      channel="#reviews"
      events={["mentioned"]}
      quietHours={quietHours}
      disabled={false}
      change={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  return (await screen.findByRole("group")) as HTMLElement;
}

const names = (group: HTMLElement) =>
  within(group)
    .getAllByRole("menuitemcheckbox")
    .map((item) => item.textContent);

it("sets apart the events quiet hours hold back, with the hours", async () => {
  const group = await quietGroup({ start: 22, end: 8 });
  expect(within(group).getByText("Held from 22:00 to 08:00, sent together after")).toBeTruthy();
  expect(names(group)).toEqual([
    "Someone comments on my pull request",
    "Someone mentions me in a pull request",
  ]);
});

it("says they are sent at any hour without quiet hours", async () => {
  const group = await quietGroup(null);
  expect(within(group).getByText("Sent at any hour: no quiet hours set")).toBeTruthy();
});
