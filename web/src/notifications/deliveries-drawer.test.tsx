import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyChannelView, NotifyDeliveryView } from "../../../src/shared/index.js";
import { Notifications } from "../pages/Notifications.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SECRET = "whsec_synthetic-secret-for-the-test";
const channel = (more: Partial<NotifyChannelView> = {}): NotifyChannelView => ({
  id: "n1",
  kind: "webhook",
  name: "Deploy bot",
  when: "every",
  last4: "hook",
  confirmed: true,
  digest: false,
  weekly: false,
  events: [],
  reminderHours: null,
  quietHours: null,
  lastStatus: null,
  lastSentAt: null,
  createdAt: "2026-11-20T10:00:00Z",
  ...more,
});
const delivery = (id: string, more: Partial<NotifyDeliveryView>): NotifyDeliveryView => ({
  id,
  event: "review_completed",
  state: "delivered",
  attempts: 1,
  status: 200,
  error: null,
  latencyMs: 84,
  retryAt: null,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  ...more,
});

function serve(channels: NotifyChannelView[], deliveries: NotifyDeliveryView[]) {
  const sent: { url: string; method: string }[] = [];
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ url, method });
      if (url.endsWith("/deliveries")) return Response.json({ deliveries });
      if (url.endsWith("/secret")) return Response.json({ secret: SECRET });
      if (url === "/api/notifications/time-zone") return Response.json({ timeZone: "UTC" });
      if (url === "/api/notifications/report")
        return Response.json({ weekday: 1, hour: 9, next: "2026-11-23T09:00:00.000Z" });
      return Response.json({ channels, email: false });
    }),
  );
  return { sent, writeText };
}

describe("a webhook channel", () => {
  it("shows how its deliveries went: the answer, the time taken and the attempts", async () => {
    serve(
      [channel(), channel({ id: "n2", kind: "slack", name: "#reviews" })],
      [
        delivery("d1", {}),
        delivery("d2", {
          event: "ping",
          state: "pending",
          attempts: 3,
          status: 503,
          error: "status",
          retryAt: new Date(Date.now() + 200_000).toISOString(),
        }),
        delivery("d3", { state: "failed", status: null, error: "timeout", latencyMs: null }),
      ],
    );
    render(<Notifications platforms={["github"]} />);
    fireEvent.click(await screen.findByRole("button", { name: /deliveries to Deploy bot$/ }));
    const list = await screen.findByRole("region", { name: "Recent deliveries" });
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "review_completedDeliveredHTTP 200, 84 ms1h ago",
      "pingWill retryHTTP 503, 84 ms, 3 attempts, next in 4m1h ago",
      "review_completedFailedTimed out1h ago",
    ]);
  });

  it("replaces its secret only after a second press, and shows the new one once with Copy", async () => {
    const { sent, writeText } = serve([channel()], []);
    render(<Notifications platforms={["github"]} />);
    fireEvent.click(await screen.findByRole("button", { name: /deliveries to Deploy bot$/ }));
    const box = screen.getByRole("region", { name: "Signing secret" });
    expect(
      within(box).getByRole("link", { name: "Verify the signature" }).getAttribute("href"),
    ).toMatch(/self-hosting\.md#outgoing-webhooks$/);
    fireEvent.click(within(box).getByRole("button", { name: "Replace secret" }));
    expect(sent).toEqual([]);
    await act(
      async () =>
        void fireEvent.click(within(box).getByRole("button", { name: "Confirm: replace secret" })),
    );
    expect(sent).toEqual([{ url: "/api/notifications/channels/n1/secret", method: "POST" }]);
    expect(within(box).getByText(SECRET)).toBeTruthy();
    await act(async () => void fireEvent.click(within(box).getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /deliveries to Deploy bot$/ }));
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("is not the only kind with deliveries: a chat's show, without a signing secret", async () => {
    serve(
      [channel({ id: "n2", kind: "slack", name: "#reviews" })],
      [
        delivery("d1", { state: "failed", status: 404, error: "status", latencyMs: 12 }),
        delivery("d2", { event: "held_notices" }),
      ],
    );
    render(<Notifications platforms={["github"]} />);
    fireEvent.click(await screen.findByRole("button", { name: /deliveries to #reviews$/ }));
    const list = await screen.findByRole("region", { name: "Recent deliveries" });
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "Review finishedFailedHTTP 404, 12 ms1h ago",
      "Notices held in quiet hoursDeliveredHTTP 200, 84 ms1h ago",
    ]);
    expect(screen.getByRole("heading", { name: "#reviews" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Signing secret" })).toBeNull();
  });

  it("has no quiet hours among its reminders, which a chat has", async () => {
    serve([channel(), channel({ id: "n2", kind: "slack", name: "#reviews" })], []);
    render(<Notifications platforms={["github"]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Reminders to Deploy bot/ }));
    expect(screen.queryByText("Quiet hours")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /^Reminders to #reviews/ }));
    expect(screen.getByText("Quiet hours")).toBeTruthy();
  });
});
