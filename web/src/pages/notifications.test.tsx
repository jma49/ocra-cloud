import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache.js";
import { span } from "../insights/cycle.js";
import { Notifications } from "./Notifications.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
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
  reminderHours: null,
  quietHours: null,
  lastStatus: null,
  removesAt: null,
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
    render(<Notifications platforms={["github", "gitlab"]} />);
    await screen.findByText("No channels yet");
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
    fireEvent.click(screen.getByRole("button", { name: "Actions for #reviews" }));
    await act(
      async () => void fireEvent.click(await screen.findByRole("menuitem", { name: "Send test" })),
    );
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
    render(<Notifications platforms={["github", "gitlab"]} />);
    await screen.findByText("No channels yet");
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

  it("moves a switch at once, and back when the save is refused", async () => {
    let refuse: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") return new Promise<Response>((r) => (refuse = r));
        if (url === "/api/notifications/report") return Response.json(SLOT);
        return Response.json({ email: true, channels: [channel] });
      }),
    );
    render(<Notifications platforms={["github"]} />);
    const digest = await screen.findByRole("switch", { name: "Daily digest to #reviews" });
    await act(async () => void fireEvent.click(digest));
    expect(digest.getAttribute("aria-checked")).toBe("true");
    await act(async () => refuse(Response.json({ error: "internal" }, { status: 500 })));
    await waitFor(() => expect(digest.getAttribute("aria-checked")).toBe("false"));
  });

  it("is not offered where this server cannot send mail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ email: false, channels: [] })),
    );
    render(<Notifications platforms={["github", "gitlab"]} />);
    await screen.findByText("No channels yet");
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
    render(<Notifications platforms={["github", "gitlab"]} />);
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
  it("are chosen per channel, one at a time, with what a choice changes said below", async () => {
    const sent: unknown[] = [];
    let events = ["review_requested", "checks_failed"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/notifications/report") return Response.json(SLOT);
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body));
          sent.push(body);
          events = body.events;
          return Response.json({ channel });
        }
        return Response.json({ channels: [{ ...channel, events }], email: false });
      }),
    );
    render(<Notifications platforms={["github", "gitlab"]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "My pull requests' events to #reviews: 2 of 11" }),
    );
    const merged = await screen.findByRole("menuitemcheckbox", {
      name: "My pull request is merged or closed",
    });
    expect(merged.getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "A review is asked of me" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => void fireEvent.click(merged));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ events: ["review_requested", "pull_closed", "checks_failed"] });
    expect(await screen.findByText(/in place of the review's announcement/)).toBeTruthy();
  });
});

describe("a pull request's time", () => {
  it("reads in minutes, hours or days", () => {
    expect(span(null)).toBe("–");
    expect(span(20_000)).toBe("1m");
    expect(span(45 * 60_000)).toBe("45m");
    expect(span(5.5 * 3_600_000)).toBe("5.5h");
    expect(span(30 * 3_600_000)).toBe("30h");
    expect(span(3 * 86_400_000)).toBe("3d");
  });

  it("shows the end of a webhook address, never the end of an inbox or a member", async () => {
    const channels = [
      channel,
      { ...channel, id: "n2", kind: "email", name: "My inbox", last4: ".com" },
      { ...channel, id: "n3", kind: "slack_dm", name: "Ada", last4: "B3CD" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url === "/api/notifications/report" ? SLOT : { channels }),
      ),
    );
    render(<Notifications platforms={["github"]} />);
    await screen.findByText("My inbox");
    expect(screen.getByText("…Xy9Q")).toBeTruthy();
    expect(screen.queryByText("….com")).toBeNull();
    expect(screen.queryByText("…B3CD")).toBeNull();
  });

  it("says when a channel nobody confirmed is removed", async () => {
    const waiting = {
      ...channel,
      id: "n2",
      kind: "email",
      name: "My inbox",
      confirmed: false,
      removesAt: "2026-11-30T12:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url === "/api/notifications/report" ? SLOT : { channels: [channel, waiting] },
        ),
      ),
    );
    render(<Notifications platforms={["github"]} />);
    await screen.findByText("My inbox");
    expect(screen.getAllByText(/removed on .*30.* unless confirmed/)).toHaveLength(1);
  });
});
