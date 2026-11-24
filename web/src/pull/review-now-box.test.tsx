import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullReviewJobView } from "../../../src/shared/index.js";
import { ReviewNowBox } from "./review-now-box.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };
const job = (over: Partial<PullReviewJobView> = {}): PullReviewJobView => ({
  state: "done",
  jobId: "j1",
  head: HEAD,
  queuedAt: new Date().toISOString(),
  depth: null,
  ...over,
});

/** Serves the card: the job it reads first, and the one a request answers with. */
function serve(
  first: PullReviewJobView | null | "not_enrolled",
  asked = job({ state: "queued" }),
  callsToday = 0,
  spentTodayUsd = 0,
) {
  const sent: unknown[] = [];
  let current = first;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/budget")) {
        return Response.json({
          serviceDailyCalls: 500,
          maxDailyCalls: 20_000,
          dailyCalls: null,
          callsToday,
          spend: {
            dailyUsd: null,
            monthlyUsd: null,
            spentTodayUsd,
            spentMonthUsd: spentTodayUsd,
            defaults: { dailyUsd: 10, monthlyUsd: 100 },
          },
        });
      }
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        current = asked;
        return Response.json({ job: asked, depth: "standard" });
      }
      return current === "not_enrolled"
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ job: current, depth: "standard" });
    }),
  );
  return sent;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("the AI review card on a pull request", () => {
  it("asks for a review of a pull request not reviewed yet, then waits for it", async () => {
    const sent = serve(null);
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText(/has not reviewed this pull request/)).toBeTruthy();
    await act(async () => void fireEvent.click(button("Review now")));
    expect(sent).toEqual([{ ...pull, force: false }]);
    expect(await screen.findByText(/A review of this head is queued/)).toBeTruthy();
    expect(button("Review now").disabled).toBe(true);
  });

  it("asks for a review at another depth than the repository's", async () => {
    const sent = serve(null);
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    fireEvent.click(await screen.findByRole("button", { name: "Depth of this review: Standard" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Deep/ }));
    // The pick closes the menu, so the next click lands on Review now instead of closing it.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("button", { name: "Depth of this review: Deep" })).toBeTruthy();
    await act(async () => void fireEvent.click(button("Review now")));
    expect(sent).toEqual([{ ...pull, force: false, depth: "deep" }]);
  });

  it("forces a second review of a head already reviewed", async () => {
    const sent = serve(job());
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText(/ocra reviewed this head/)).toBeTruthy();
    await act(async () => void fireEvent.click(button("Review again")));
    expect(sent).toEqual([{ ...pull, force: true }]);
  });

  it("says when the last review was of an older head, and does not force the new one", async () => {
    const sent = serve(job({ head: "b".repeat(40) }));
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText(/was of bbbbbbb, before the newest commits/)).toBeTruthy();
    await act(async () => void fireEvent.click(button("Review now")));
    expect(sent).toEqual([{ ...pull, force: false }]);
  });

  it("says a review asked now waits, once the day's model calls are used", async () => {
    serve(null, undefined, 500);
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText(/waits and starts at .*, when the limit resets\./)).toBeTruthy();
    expect(button("Review now").disabled).toBe(false);
  });

  it("says a review asked now waits, once the day's spend limit is reached", async () => {
    serve(null, undefined, 0, 10.4);
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText("Daily spend limit reached")).toBeTruthy();
    expect(screen.getByText(/Reviews cost \$10\.40 today, of a \$10\.00 limit\./)).toBeTruthy();
    expect(screen.getByText(/or once you raise it/)).toBeTruthy();
    expect(button("Review now").disabled).toBe(false);
  });

  it("says nothing of the limit while calls are left", async () => {
    serve(null, undefined, 499);
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText(/has not reviewed this pull request/)).toBeTruthy();
    expect(screen.queryByText(/Daily limit reached/)).toBeNull();
  });

  it("leads to auto review for a repository the account did not enroll", async () => {
    serve("not_enrolled");
    render(<ReviewNowBox pull={pull} head={HEAD} />);
    expect(await screen.findByText(/This one is not among them/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up auto review" }).getAttribute("href")).toBe(
      "/auto-review",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stops asking while the tab is hidden, and asks again once it shows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      serve(job({ state: "running" }));
      const reads = () => vi.mocked(fetch).mock.calls.length;
      render(<ReviewNowBox pull={pull} head={HEAD} />);
      expect(await screen.findByText(/ocra is reviewing this head/)).toBeTruthy();
      const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const before = reads();
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(reads()).toBe(before);
      hidden.mockReturnValue("visible");
      await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
      expect(reads()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the page once a review it watched finishes, and not for one done before", async () => {
    serve(job({ state: "running" }));
    const reviewed = vi.fn();
    render(<ReviewNowBox pull={pull} head={HEAD} onReviewed={reviewed} />);
    expect(await screen.findByText(/ocra is reviewing this head/)).toBeTruthy();
    expect(reviewed).not.toHaveBeenCalled();
    serve(job());
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(await screen.findByText(/ocra reviewed this head/)).toBeTruthy();
    expect(reviewed).toHaveBeenCalledOnce();
    cleanup();
    const before = vi.fn();
    render(<ReviewNowBox pull={pull} head={HEAD} onReviewed={before} />);
    expect(await screen.findByText(/ocra reviewed this head/)).toBeTruthy();
    expect(before).not.toHaveBeenCalled();
  });
});
