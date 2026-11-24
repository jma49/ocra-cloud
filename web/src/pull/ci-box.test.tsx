import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PullCiJob, PullCiView } from "../../../src/shared/index.js";
import { CiBox } from "./ci-box.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "b".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };

const job = (over: Partial<PullCiJob>): PullCiJob => ({
  id: "1",
  name: "test",
  source: "github_actions",
  state: "passed",
  startedAt: null,
  finishedAt: null,
  durationSeconds: 83,
  url: "https://github.com/octo/api/actions/runs/1/job/1",
  failedStep: null,
  failureReason: null,
  hasLog: true,
  rerunnable: true,
  mend: null,
  ...over,
});

const view = (jobs: PullCiJob[]): PullCiView => ({
  platform: "github",
  repo: "octo/api",
  number: 7,
  head: HEAD,
  pipeline: null,
  jobs,
  more: false,
});

type Answer = (url: string, init?: RequestInit) => unknown;

function serve(answer: Answer) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => Response.json(answer(url, init)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const ci = (jobs: PullCiJob[], rest: Answer = () => ({})) =>
  serve((url, init) => (url.includes("/pulls/ci?") ? view(jobs) : rest(url, init)));

it("leads with failed jobs and their failed step, the rest folded by count", async () => {
  ci([
    job({ id: "2", name: "lint", state: "failed", failedStep: "Run biome" }),
    job({ id: "3", name: "build" }),
    job({ id: "4", name: "e2e", state: "pending", durationSeconds: null }),
  ]);
  render(<CiBox pull={pull} head={HEAD} />);
  const box = await screen.findByRole("region", { name: "CI" });
  expect(within(box).getByText("1 failed")).toBeTruthy();
  expect(within(box).getByText("Run biome · 1m 23s")).toBeTruthy();
  expect(within(box).getByText("1 passed, 1 running")).toBeTruthy();
  expect(within(box).getByRole("button", { name: "Rerun failed" })).toBeTruthy();
});

it("says plainly when GitHub refuses a rerun for the App's missing permission", async () => {
  const fetch = ci([job({ state: "failed" })], () => ({ outcome: "refused", rerun: 0 }));
  render(<CiBox pull={pull} head={HEAD} />);
  fireEvent.click(await screen.findByRole("button", { name: "Rerun failed" }));
  expect(await screen.findByText(/needs the Actions write permission/)).toBeTruthy();
  const sent = fetch.mock.calls.find(([u]) => String(u).includes("/ci/rerun"));
  expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ ...pull, head: HEAD });
});

it("names what the fix loop made of a failed job", async () => {
  ci([
    job({
      state: "failed",
      mend: { check: "test", outcome: "needs_human", reason: "unsure", cause: null },
    }),
  ]);
  render(<CiBox pull={pull} head={HEAD} />);
  expect(await screen.findByText("ocra left it to a person.")).toBeTruthy();
});

it("opens a failed job's log and explains it on request", async () => {
  ci([job({ state: "failed", name: "test" })], (url) =>
    url.includes("/ci/log")
      ? {
          job: "1",
          name: "test",
          url: null,
          source: "job_log",
          log: "FAIL src/a.test.ts\nexpected 2 got 3",
          redacted: false,
        }
      : {
          job: "1",
          name: "test",
          url: null,
          source: "job_log",
          model: "ocra-anthropic/claude-haiku-5-5",
          explanation: "The assertion in `a.test.ts` expects 2.",
          redacted: false,
        },
  );
  render(<CiBox pull={pull} head={HEAD} />);
  fireEvent.click(await screen.findByRole("button", { name: "Log" }));
  const drawer = await screen.findByRole("dialog", { name: "Log of test" });
  expect(await within(drawer).findByText(/expected 2 got 3/)).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "Explain the failure" }));
  expect(await within(drawer).findByText(/expects 2/)).toBeTruthy();
  expect(within(drawer).getByText(/claude-haiku-5-5/)).toBeTruthy();
});

it("shows nothing while the platform reports no jobs", async () => {
  const fetch = ci([]);
  const { container } = render(<CiBox pull={pull} head={HEAD} />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});
