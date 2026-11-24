import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  FixJobView,
  MendItemView,
  PullFindingView,
  PullMendView,
} from "../../../src/shared/index.js";
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
  cause: null,
  error: null,
  createdAt: "2026-11-23T10:00:00.000Z",
  finishedAt: null,
  ...over,
});

const NO_LOOP: PullMendView = { level: "propose", loop: null, items: [] };

const item = (over: Partial<MendItemView>): MendItemView => ({
  finding: "f1",
  outcome: null,
  reason: null,
  cause: null,
  commit: null,
  requestedAt: "2026-11-23T10:00:00.000Z",
  finishedAt: null,
  ...over,
});

const looping = (items: MendItemView[], state: "queued" | "running" | "done" = "done") =>
  ({
    level: "commit",
    loop: { state, outcome: null, error: null, finishedAt: null },
    items,
  }) satisfies PullMendView;

/**
 * Answers the pull request's requests in turn (the last one stays), and its
 * loop's reads the same way; takes a new request unless `refuse`.
 */
function serve(
  reads: FixJobView[][],
  opts: { enrolled?: boolean; refuse?: boolean; loop?: PullMendView[] } = {},
) {
  const asked: unknown[] = [];
  let read = 0;
  let turn = 0;
  const loops = opts.loop ?? [NO_LOOP];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/auto-review/mends")) {
        if (init?.method !== "POST")
          return Response.json(loops[Math.min(turn++, loops.length - 1)]);
        if (opts.refuse) return Response.json({ error: "daily_limit" }, { status: 429 });
        asked.push({ loop: JSON.parse(String(init.body)) });
        return Response.json({ outcome: "queued", mend: loops.at(-1) });
      }
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

/** Lets the effects of what was just drawn run (the poll's timer among them), then passes the time. */
const later = async (ms: number) => {
  await act(async () => {});
  vi.advanceTimersByTime(ms);
};

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
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
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

it("says what failed in the fixer's call where the run named it", async () => {
  serve([[job({ state: "done", outcome: "rejected", reason: "failed", cause: "quota" })]]);
  show(finding());
  expect(
    await screen.findByText("No fix: the model's quota or rate limit is used up."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try the fix again" })).toBeTruthy();
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
  await later(5_000);
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

it("asks the pull request's loop where ocra commits its fixes, and follows the finding to its commit", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixed = vi.fn();
  const asked = serve([[]], {
    loop: [
      looping([]),
      looping([item({})], "queued"),
      looping([item({})], "running"),
      looping([item({ outcome: "fixed", commit: "abcdef0123456789" })]),
    ],
  });
  show(finding(), fixed);
  fireEvent.click(await screen.findByRole("button", { name: "Fix with ocra" }));
  expect(await screen.findByText("Fix queued")).toBeTruthy();
  expect(asked).toEqual([{ loop: { findings: ["f1"] } }]);
  await later(5_000);
  expect(await screen.findByText("Fixing")).toBeTruthy();
  expect(fixed).not.toHaveBeenCalled();
  await later(5_000);
  expect((await screen.findByText(/^Fixed/)).textContent).toBe("Fixed abcdef0");
  expect(fixed).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

it("says why the loop committed no fix, and offers again only what another round may fix", async () => {
  serve([[]], { loop: [looping([item({ outcome: "needs_human", reason: "protected" })])] });
  show(finding());
  expect(
    await screen.findByText(
      "No fix: it needs a file ocra does not edit. This one is for a person.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  serve([[]], { loop: [looping([item({ outcome: "rejected", reason: "unresolved" })])] });
  show(finding());
  expect(await screen.findByRole("button", { name: "Try the fix again" })).toBeTruthy();
  expect(
    screen.getByText("No fix: the fix it wrote did not pass ocra's check of it."),
  ).toBeTruthy();
});
