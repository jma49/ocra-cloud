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
  confirmed: true,
  digest: false,
  weekly: false,
  events: [],
  lastStatus: null,
  lastSentAt: null,
  createdAt: "2026-11-20T10:00:00Z",
};

const SLOT = { weekday: 1, hour: 9, next: "2026-11-23T09:00:00.000Z" };

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
        if (url === "/api/notifications/report") return Response.json(SLOT);
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
        digest: false,
        weekly: false,
        url: "https://hooks.slack.com/services/T/B/x",
      },
    });
    await screen.findByText("#reviews");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send test" })));
    await waitFor(() => expect(screen.getByText("Test not delivered")).toBeTruthy());
    expect(sent[1]).toMatchObject({ url: "/api/notifications/channels/n1/test", method: "POST" });
  });
});

describe("an email channel", () => {
  it("says a confirmation link went out, waits for it, and turns the digest on with a switch", async () => {
    const sent: { url: string; method: string; body: unknown }[] = [];
    const mail = { ...channel, id: "m1", kind: "email", name: "Ada", confirmed: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method !== "GET") sent.push({ url, method, body });
        if (method === "POST") return Response.json({ channel: mail, confirmationSent: true });
        if (method === "PATCH") return Response.json({ channel: mail });
        return Response.json({ email: true, channels: sent.length ? [mail] : [] });
      }),
    );
    render(<Notifications />);
    await screen.findByText("No channels yet.");
    fireEvent.change(screen.getByLabelText("Where"), { target: { value: "email" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByLabelText("Daily digest of yesterday's reviews"));
    fireEvent.click(screen.getByLabelText("Weekly report"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(sent[0]?.body).toEqual({
      kind: "email",
      name: "Ada",
      when: "blocking",
      digest: true,
      weekly: true,
      address: "ada@example.com",
    });
    expect(await screen.findByText(/A link to confirm Ada is on its way/)).toBeTruthy();
    expect(await screen.findByText("Awaiting confirmation")).toBeTruthy();
    await act(
      async () => void fireEvent.click(screen.getByRole("switch", { name: "Daily digest to Ada" })),
    );
    expect(sent[1]).toEqual({
      url: "/api/notifications/channels/m1",
      method: "PATCH",
      body: { digest: true },
    });
  });

  it("is not offered where this server cannot send mail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ email: false, channels: [] })),
    );
    render(<Notifications />);
    await screen.findByText("No channels yet.");
    expect(screen.queryByRole("option", { name: "Email" })).toBeNull();
  });
});

describe("the weekly report", () => {
  it("is switched on per channel, and its UTC day and hour are saved", async () => {
    const sent: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method !== "GET") sent.push({ url, method, body });
        if (url === "/api/notifications/report") return Response.json(body ?? SLOT);
        if (method === "PATCH") return Response.json({ channel: { ...channel, weekly: true } });
        return Response.json({ channels: [channel], email: false });
      }),
    );
    render(<Notifications />);
    const weekly = await screen.findByRole("switch", { name: "Weekly report to #reviews" });
    await act(async () => void fireEvent.click(weekly));
    fireEvent.change(await screen.findByLabelText("Weekly report day"), { target: { value: "5" } });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { url: "/api/notifications/channels/n1", method: "PATCH", body: { weekly: true } },
      { url: "/api/notifications/report", method: "PUT", body: { weekday: 5, hour: 9 } },
    ]);
  });
});

describe("my pull requests' events", () => {
  it("are switched on per channel, all of them", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/notifications/report") return Response.json(SLOT);
        if (method === "PATCH") {
          sent.push(JSON.parse(String(init?.body)));
          return Response.json({ channel });
        }
        return Response.json({ channels: [channel], email: false });
      }),
    );
    render(<Notifications />);
    const toggle = await screen.findByRole("switch", {
      name: "My pull requests' events to #reviews",
    });
    await act(async () => void fireEvent.click(toggle));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      events: [
        "review_requested",
        "pull_reviewed",
        "pull_closed",
        "checks_failed",
        "review_blocking",
      ],
    });
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
