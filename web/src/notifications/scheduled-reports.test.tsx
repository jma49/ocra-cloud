import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyChannelView, ScheduledReportView } from "../../../src/shared/index.js";
import { ScheduledReports } from "./scheduled-reports.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channel = (id: string, name: string, kind: string, confirmed = true) =>
  ({ id, name, kind, confirmed }) as NotifyChannelView;
const channels = [
  channel("n1", "#payments", "slack"),
  channel("n2", "ada@example.com", "email", false),
  channel("n3", "Pager", "webhook"),
];
const report: ScheduledReportView = {
  id: "s1",
  name: "Payments weekly",
  enabled: true,
  cadence: "weekly",
  hour: 9,
  weekday: 1,
  monthDay: null,
  repoIds: ["p1"],
  sections: ["reviews", "merged"],
  channelIds: ["n1"],
  next: "2026-11-30T09:00:00Z",
  timeZone: "Europe/Berlin",
  lastSent: null,
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
};
const preview = {
  period: { key: "2026-W48", from: "2026-11-23T08:00:00Z", to: "2026-11-23T19:00:00Z" },
  subject: "Payments weekly",
  lines: ["4 reviews of 3 pull requests", "2 merged"],
  empty: false,
};

type Sent = { url: string; method: string; body: unknown };
function serve(reports: ScheduledReportView[], refuseSend = false) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET")
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/scheduled-reports" && method === "GET")
        return Response.json({ reports, max: 10 });
      if (url === "/api/auto-review/repos")
        return Response.json({ repos: [{ id: "p1", fullName: "acme/payments" }] });
      if (url === "/api/notifications/time-zone")
        return Response.json({ timeZone: "Europe/Berlin" });
      if (url.endsWith("/preview")) return Response.json(preview);
      if (url.endsWith("/send"))
        return refuseSend
          ? Response.json({ error: "daily_limit" }, { status: 429 })
          : Response.json({ ...preview, empty: true, delivered: 1, channels: 1 });
      return Response.json({ report });
    }),
  );
  return sent;
}

const press = (name: string) =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name })));

describe("the account's custom reports", () => {
  it("says when each goes and what it holds, and turns one off", async () => {
    const sent = serve([report]);
    render(<ScheduledReports channels={channels} enrolls />);
    expect(
      await screen.findByText(
        "Every Monday at 09:00, Europe/Berlin · 2 sections · 1 repository · 1 channel",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Next on /)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("switch")));
    expect(sent[0]).toMatchObject({
      url: "/api/scheduled-reports/s1",
      method: "PUT",
      body: { name: "Payments weekly", enabled: false, weekday: 1, channelIds: ["n1"] },
    });
  });

  it("sends one now and says where it went, or why it did not", async () => {
    serve([report]);
    render(<ScheduledReports channels={channels} enrolls />);
    await screen.findByText("Payments weekly");
    await press("Send Payments weekly now");
    expect(screen.getByRole("status").textContent).toBe(
      "Sent “Payments weekly” to 1 of 1 channel, though its period has no reviews or merges yet.",
    );
    cleanup();
    serve([report], true);
    render(<ScheduledReports channels={channels} enrolls />);
    await screen.findByText("Payments weekly");
    await press("Send Payments weekly now");
    expect(screen.getByRole("alert").textContent).toMatch(/send the report/);
  });

  it("writes a monthly report for chosen sections and channels, with its preview", async () => {
    const sent = serve([]);
    render(<ScheduledReports channels={channels} enrolls />);
    await screen.findByText(/^Define a report of your own/);
    await press("New report");
    const form = screen.getByRole("form", { name: "New report" });
    const add = within(form).getByRole("button", { name: "Add report" }) as HTMLButtonElement;
    expect(within(form).queryByLabelText("Channel Pager")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Report name"), {
      target: { value: "Month in review" },
    });
    expect(add.disabled).toBe(true);
    fireEvent.click(within(form).getByLabelText("Channel #payments"));
    fireEvent.click(within(form).getByRole("button", { name: "Monthly" }));
    expect(within(form).queryByLabelText("Day of the week")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Day of the month"), { target: { value: "5" } });
    fireEvent.change(within(form).getByLabelText("Hour"), { target: { value: "8" } });
    fireEvent.click(within(form).getByLabelText("Section Median time to merge"));
    fireEvent.click(within(form).getByLabelText("Repository acme/payments"));

    const content = {
      cadence: "monthly",
      hour: 8,
      weekday: null,
      monthDay: 5,
      repoIds: ["p1"],
      sections: ["reviews", "merged", "time_to_merge"],
    };
    await waitFor(() => expect(within(form).getByText("2 merged")).toBeTruthy(), {
      timeout: 3000,
    });
    expect(sent).toEqual([
      { url: "/api/scheduled-reports/preview", method: "POST", body: content },
    ]);
    await act(async () => void fireEvent.click(add));
    expect(sent[1]).toEqual({
      url: "/api/scheduled-reports",
      method: "POST",
      body: { name: "Month in review", enabled: true, ...content, channelIds: ["n1"] },
    });
  });

  it("offers no empty list, and no new report, before the reports are read", async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    render(<ScheduledReports channels={channels} enrolls={false} />);
    const add = screen.getByRole("button", { name: "New report" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.queryByText(/^Define a report of your own/)).toBeNull();
    await act(async () => answer(Response.json({ reports: [], max: 10 })));
    expect(await screen.findByText(/^Define a report of your own/)).toBeTruthy();
    expect(add.disabled).toBe(false);
  });

  it("asks for a channel first where the account has none a report can go to", async () => {
    serve([]);
    render(<ScheduledReports channels={[channel("n3", "Pager", "webhook")]} enrolls={false} />);
    expect(await screen.findByText(/a report goes to people, not to a webhook/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "New report" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
