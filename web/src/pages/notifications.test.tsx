import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { span } from "../insights/cycle.js";
import { Notifications } from "./Notifications.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channel = {
  id: "n1",
  kind: "slack",
  name: "#reviews",
  when: "blocking",
  last4: "Xy9Q",
  lastStatus: null,
  lastSentAt: null,
  createdAt: "2026-11-20T10:00:00Z",
};

describe("the Notifications page", () => {
  it("adds a channel with its address, and shows what a test message did", async () => {
    const sent: { url: string; method: string; body: unknown }[] = [];
    let channels: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method !== "GET") sent.push({ url, method, body });
        if (url === "/api/notifications/channels" && method === "POST") {
          channels = [channel];
          return Response.json({ channel });
        }
        if (url.endsWith("/test")) return Response.json({ delivered: false });
        return Response.json({ channels });
      }),
    );
    render(<Notifications />);
    await screen.findByText("No channels yet.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " #reviews " } });
    fireEvent.change(screen.getByLabelText("Webhook address"), {
      target: { value: "https://hooks.slack.com/services/T/B/x" },
    });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(sent[0]).toEqual({
      url: "/api/notifications/channels",
      method: "POST",
      body: {
        kind: "slack",
        name: "#reviews",
        when: "blocking",
        url: "https://hooks.slack.com/services/T/B/x",
      },
    });
    await screen.findByText("#reviews");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send test" })));
    await waitFor(() => expect(screen.getByText("Test not delivered")).toBeTruthy());
    expect(sent[1]).toMatchObject({ url: "/api/notifications/channels/n1/test", method: "POST" });
  });
});

describe("a pull request's time", () => {
  it("reads in minutes, hours or days", () => {
    expect(span(null)).toBe("–");
    expect(span(20_000)).toBe("1m");
    expect(span(45 * 60_000)).toBe("45m");
    expect(span(5.5 * 3_600_000)).toBe("5.5h");
    expect(span(30 * 3_600_000)).toBe("30h");
    expect(span(3 * 86_400_000)).toBe("3.0d");
  });
});
