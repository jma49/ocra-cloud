import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Budget } from "./budget.js";
import { CallsCard } from "./calls-card.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const budget = (over: Partial<Budget> = {}): Budget => ({
  serviceDailyCalls: 500,
  maxDailyCalls: 20_000,
  dailyCalls: null,
  callsToday: 500,
  spend: {
    dailyUsd: null,
    monthlyUsd: null,
    spentTodayUsd: 0,
    spentMonthUsd: 0,
    defaults: { dailyUsd: 10, monthlyUsd: 100 },
  },
  ...over,
});

function serve() {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({});
    }),
  );
  return sent;
}

describe("the daily calls card", () => {
  it("raises the limit above the default, but not past the server's ceiling", async () => {
    const sent = serve();
    render(<CallsCard budget={budget()} onSaved={() => {}} />);
    expect(screen.getByText(/The limit is reached/)).toBeTruthy();
    const field = screen.getByLabelText("Daily limit");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.change(field, { target: { value: "20001" } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText("A limit is a whole number from 1 to 20,000.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "2000" } });
    await act(async () => void fireEvent.click(save));
    expect(sent).toEqual([{ dailyCalls: 2000 }]);
  });

  it("turns the limit off, which leaves the server's ceiling", async () => {
    const sent = serve();
    const { rerender } = render(<CallsCard budget={budget()} onSaved={() => {}} />);
    await act(
      async () => void fireEvent.click(screen.getByRole("switch", { name: "Daily limit on" })),
    );
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(sent).toEqual([{ dailyCalls: 0 }]);
    rerender(<CallsCard budget={budget({ dailyCalls: 0 })} onSaved={() => {}} />);
    expect(screen.getByText("500").parentElement?.textContent).toBe("500 of 20,000 calls today");
    expect(screen.getByText("Your limit is off; this server stops at 20,000.")).toBeTruthy();
  });
});
