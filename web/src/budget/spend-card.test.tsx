import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpendView } from "../../../src/shared/index.js";
import { limitReached } from "../auto-review/limit-reached.js";
import { SpendCard } from "./spend-card.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const spend = (over: Partial<SpendView> = {}): SpendView => ({
  dailyUsd: null,
  monthlyUsd: null,
  spentTodayUsd: 0,
  spentMonthUsd: 0,
  defaults: { dailyUsd: 10, monthlyUsd: 100 },
  ...over,
});

describe("the spend limit card", () => {
  it("shows each window's spend against its limit, and what a limit near or reached means", () => {
    render(
      <SpendCard
        spend={spend({ dailyUsd: 5, spentTodayUsd: 5.2, spentMonthUsd: 85 })}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByText("$5.20").parentElement?.textContent).toBe("Today $5.20 of $5.00");
    expect(screen.getByText("$85.00").parentElement?.textContent).toBe(
      "This month $85.00 of $100.00",
    );
    expect(screen.getByText(/hosted reviews wait until it resets or you raise it/)).toBeTruthy();
    expect(screen.getByText("Over 80% used.")).toBeTruthy();
  });

  it("saves both limits, an empty one as the default, and refuses what is not an amount", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }),
    );
    const saved = vi.fn();
    render(<SpendCard spend={spend({ monthlyUsd: 50 })} onSaved={saved} />);
    const daily = screen.getByLabelText("Daily limit");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.change(daily, { target: { value: "0" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(daily, { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Monthly limit"), { target: { value: "" } });
    await act(async () => void fireEvent.click(save));
    expect(sent).toEqual([{ dailyUsd: 2.5, monthlyUsd: null }]);
    expect(saved).toHaveBeenCalledOnce();
  });
});

describe("the limit that holds hosted reviews back", () => {
  const budget = (s: SpendView, callsToday = 0) => ({
    serviceDailyCalls: 500,
    dailyCalls: null,
    callsToday,
    spend: s,
  });

  it("is the month's when both spend limits are reached, and none while under every limit", () => {
    expect(limitReached(budget(spend({ spentTodayUsd: 9.99, spentMonthUsd: 99 })))).toBeNull();
    expect(limitReached(budget(spend({ spentTodayUsd: 12, spentMonthUsd: 100 })))?.badge).toBe(
      "Monthly spend limit reached",
    );
    expect(limitReached(budget(spend(), 500))?.badge).toBe("Daily limit reached");
  });
});
