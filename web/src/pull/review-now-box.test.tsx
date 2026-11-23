import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  ...over,
});

/** Serves the card: the job it reads first, and the one a request answers with. */
function serve(first: PullReviewJobView | null | "not_enrolled", asked = job({ state: "queued" })) {
  const sent: unknown[] = [];
  let current = first;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        current = asked;
        return Response.json({ job: asked });
      }
      return current === "not_enrolled"
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ job: current });
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
});
