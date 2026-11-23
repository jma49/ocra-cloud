import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyChannelView } from "../../../src/shared/index.js";
import { Notifications } from "../pages/Notifications.js";
import { reminderSummary } from "./reminders-drawer.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channel: NotifyChannelView = {
  id: "n1",
  kind: "slack",
  name: "#reviews",
  when: "blocking",
  last4: "Xy9Q",
  confirmed: true,
  digest: false,
  weekly: false,
  events: ["pull_reviewed"],
  reminderHours: null,
  quietHours: null,
  lastStatus: null,
  removesAt: null,
  lastSentAt: null,
  createdAt: "2026-11-20T10:00:00Z",
};

const show = async (start: NotifyChannelView, timeZone = "Europe/Berlin") => {
  const sent: { url: string; method: string; body: unknown }[] = [];
  let now = start;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== "GET") sent.push({ url, method, body });
      if (url === "/api/notifications/time-zone") return Response.json({ timeZone });
      if (url === "/api/notifications/report") {
        return Response.json({ weekday: 1, hour: 9, next: "2026-11-23T09:00:00.000Z" });
      }
      if (method === "PATCH") now = { ...now, ...body };
      return Response.json({ channels: [now], email: false });
    }),
  );
  render(<Notifications platforms={["github", "gitlab"]} enrolls={false} />);
  return { sent, button: await screen.findByRole("button", { name: /^Reminders to #reviews/ }) };
};
const save = () =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));

describe("a channel's reminders", () => {
  it("read off, or after how long, only with a reminder event and its hours", () => {
    expect(reminderSummary(channel)).toBe("Off");
    expect(reminderSummary({ events: ["pull_reviewed"], reminderHours: 24 })).toBe("Off");
    expect(reminderSummary({ events: ["review_waiting"], reminderHours: null })).toBe("Off");
    expect(reminderSummary({ events: ["review_waiting"], reminderHours: 48 })).toBe("After 2 days");
  });

  it("are switched on with their hours and quiet hours, keeping the channel's other events", async () => {
    const { sent, button } = await show(channel);
    expect(button.textContent).toBe("Off");
    fireEvent.click(button);
    fireEvent.click(screen.getByLabelText("A review asked of me is still waiting"));
    fireEvent.change(screen.getByLabelText("After"), { target: { value: "8" } });
    fireEvent.click(
      screen.getByLabelText("Send no reminder, comment or mention during these hours"),
    );
    fireEvent.change(screen.getByLabelText("Quiet until"), { target: { value: "7" } });
    await save();
    expect(sent).toEqual([
      {
        url: "/api/notifications/channels/n1",
        method: "PATCH",
        body: {
          events: ["pull_reviewed", "review_waiting"],
          reminderHours: 8,
          quietHours: { start: 22, end: 7 },
        },
      },
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Reminders to #reviews/ }).textContent).toBe(
        "After 8 hours",
      ),
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("are switched off by clearing their events, which clears the hours too", async () => {
    const { sent, button } = await show({
      ...channel,
      events: ["pull_reviewed", "review_waiting", "pull_waiting"],
      reminderHours: 24,
      quietHours: { start: 22, end: 8 },
    });
    expect(button.textContent).toBe("After 1 day");
    fireEvent.click(button);
    fireEvent.click(screen.getByLabelText("A review asked of me is still waiting"));
    fireEvent.click(screen.getByLabelText("My pull request has no review yet"));
    fireEvent.click(
      screen.getByLabelText("Send no reminder, comment or mention during these hours"),
    );
    await save();
    expect(sent[0]?.body).toEqual({
      events: ["pull_reviewed"],
      reminderHours: null,
      quietHours: null,
    });
  });

  it("save the account's time zone first when it was changed", async () => {
    const { sent, button } = await show(channel, "UTC");
    fireEvent.click(button);
    const zone = (await screen.findByLabelText("Time zone")) as HTMLSelectElement;
    await waitFor(() => expect(zone.disabled).toBe(false));
    fireEvent.change(zone, { target: { value: "Asia/Tokyo" } });
    await save();
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ["PUT", "/api/notifications/time-zone", { timeZone: "Asia/Tokyo" }],
      [
        "PATCH",
        "/api/notifications/channels/n1",
        { events: ["pull_reviewed"], reminderHours: null, quietHours: null },
      ],
    ]);
  });
});
