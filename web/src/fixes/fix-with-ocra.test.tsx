import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FixJobView, PullFindingView } from "../../../src/shared/index.js";
import { FixJobsOf } from "./fix-jobs.js";
import { FixWithOcra } from "./fix-with-ocra.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const finding = (over: Partial<PullFindingView> = {}): PullFindingView => ({
  id: "f1",
  review: "r1",
  severity: "warning",
  title: "Logs the amount",
  body: "",
  file: "src/refund.ts",
  lineStart: 11,
  lineEnd: 11,
  hasFix: false,
  lowConfidence: false,
  ...over,
});

const job = (over: Partial<FixJobView>): FixJobView => ({
  id: "j1",
  finding: "f1",
  head: "abc",
  state: "queued",
  outcome: null,
  reason: null,
  error: null,
  createdAt: "2026-11-23T10:00:00.000Z",
  finishedAt: null,
  ...over,
});

/** Answers the pull request's requests in turn (the last one stays), and takes a new one unless `refuse`. */
function serve(reads: FixJobView[][], opts: { enrolled?: boolean; refuse?: boolean } = {}) {
  const asked: unknown[] = [];
  let read = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (opts.refuse) return Response.json({ error: "daily_limit" }, { status: 429 });
        asked.push(JSON.parse(String(init.body)));
        return Response.json({ outcome: "queued", job: job({}) });
      }
      const jobs = reads[Math.min(read++, reads.length - 1)] ?? [];
      return Response.json({ enrolled: opts.enrolled ?? true, jobs });
    }),
  );
  return asked;
}

const show = (f: PullFindingView, onProposed = () => undefined) =>
  render(
    <FixJobsOf query="platform=github&repo=octo%2Fapi&number=7" onProposed={onProposed}>
      <FixWithOcra finding={f} />
    </FixJobsOf>,
  );

it("asks for a fix of the finding, and shows it queued", async () => {
  const asked = serve([[], [job({})]]);
  show(finding());
  fireEvent.click(await screen.findByRole("button", { name: "Fix with ocra" }));
  expect(await screen.findByText("Fix queued")).toBeTruthy();
  expect(asked).toEqual([{ finding: "f1" }]);
  expect(screen.queryByRole("button", { name: "Fix with ocra" })).toBeNull();
});

it("offers no fix outside an enrolled repository, for an unsure finding, or one with a fix", async () => {
  serve([[]], { enrolled: false });
  show(finding());
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  serve([[]]);
  show(finding({ lowConfidence: true }));
  show(finding({ hasFix: true }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button")).toBeNull();
});

it("says why a finished request left no fix, and offers a failed one again", async () => {
  serve([[job({ state: "done", outcome: "rejected", reason: "syntax" })]]);
  show(finding());
  expect(await screen.findByText("No fix: the fix it wrote did not parse.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  serve([[job({ state: "failed", error: "runner_gone" })]]);
  show(finding());
  expect(await screen.findByRole("button", { name: "Try the fix again" })).toBeTruthy();
  expect(screen.getByText("The fix run failed.")).toBeTruthy();
  expect(screen.queryByText("runner_gone")).toBeNull();
});

it("offers a request again when the fixer's call to the model failed", async () => {
  const asked = serve([[job({ state: "done", outcome: "rejected", reason: "failed" })], [job({})]]);
  show(finding());
  expect(
    await screen.findByText("No fix: ocra's call to the model did not go through."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try the fix again" }));
  expect(await screen.findByText("Fix queued")).toBeTruthy();
  expect(asked).toEqual([{ finding: "f1" }]);
});

it("says the day's fixes are used up when the server refuses one", async () => {
  serve([[]], { refuse: true });
  show(finding());
  fireEvent.click(await screen.findByRole("button", { name: "Fix with ocra" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Today's 50 fixes are used up. Ask again tomorrow.",
  );
});

it("tells the page when a request it watched comes back with a fix, not for one already there", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const proposed = vi.fn();
  serve([[job({ state: "running" })], [job({ state: "done", outcome: "proposed" })]]);
  show(finding(), proposed);
  expect(await screen.findByText("Writing a fix")).toBeTruthy();
  expect(proposed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5_000);
  expect(await screen.findByText("Fix proposed")).toBeTruthy();
  expect(proposed).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  cleanup();
  const again = vi.fn();
  serve([[job({ state: "done", outcome: "proposed" })]]);
  show(finding(), again);
  expect(await screen.findByText("Fix proposed")).toBeTruthy();
  expect(again).not.toHaveBeenCalled();
});
