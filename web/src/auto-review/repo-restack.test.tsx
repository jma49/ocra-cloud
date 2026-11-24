import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoReviewRepoView, RestackJobView } from "../../../src/shared/index.js";
import { clearCache } from "../cache.js";
import { RepoRestack } from "./repo-restack.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const repo = { id: "p1", fullName: "octo/api", restack: false } as AutoReviewRepoView;

const job = (over: Partial<RestackJobView>): RestackJobView => ({
  id: "j1",
  number: 8,
  parent: 7,
  branch: "feat/b",
  onto: "main",
  from: "aaaaaaa1111",
  to: "bbbbbbb2222",
  askedBy: null,
  state: "done",
  outcome: "restacked",
  reason: null,
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  ...over,
});

/** Answers the history with `jobs`, takes the switch unless `refuse`, and keeps what was put. */
function serve(jobs: RestackJobView[], refuse = false) {
  const put: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auto-review/repos/p1/restacks")
        return Response.json({ restack: false, jobs });
      if (url === "/api/auto-review/repos/p1/restack" && init?.method === "PUT") {
        put.push(JSON.parse(String(init.body)));
        return refuse
          ? Response.json({ error: "rate_limited" }, { status: 429 })
          : Response.json({ restack: true });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  return put;
}

const flip = () =>
  act(
    async () => void fireEvent.click(screen.getByRole("switch", { name: /Restack pull requests/ })),
  );

describe("a repository's restacks", () => {
  it("starts off, says what switching it on rewrites, and saves the switch", async () => {
    const put = serve([]);
    const changed = vi.fn();
    render(<RepoRestack r={repo} onChanged={changed} />);
    expect(await screen.findByText("No restacks: it is switched off.")).toBeTruthy();
    expect(screen.getByText(/rewrites contributors' branches/)).toBeTruthy();
    const box = screen.getByRole("switch", { name: /Restack pull requests/ });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await flip();
    expect(put).toEqual([{ restack: true }]);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.getByText("No restacks yet.")).toBeTruthy();
  });

  it("puts the switch back when the server refuses", async () => {
    serve([], true);
    const changed = vi.fn();
    render(<RepoRestack r={repo} onChanged={changed} />);
    await flip();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("alert").textContent).toMatch(/^Could not change it: /);
    expect(changed).not.toHaveBeenCalled();
  });

  it("lists each restack with how it ended and what that leaves to do", async () => {
    serve([
      job({}),
      job({ id: "j2", number: 9, parent: 8, to: null, outcome: "conflict" }),
      job({ id: "j3", number: 10, to: null, outcome: "skipped", reason: "up_to_date" }),
      job({ id: "j4", number: 11, to: null, state: "queued", outcome: null, finishedAt: null }),
    ]);
    render(<RepoRestack r={repo} onChanged={() => {}} />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".status")?.textContent)).toEqual([
      "Restacked",
      "Conflict",
      "Skipped",
      "Queued",
    ]);
    expect(rows[0]?.textContent).toContain("#8 onto main after #7 merged");
    expect(rows[0]?.textContent).toContain("aaaaaaa → bbbbbbb");
    expect(rows[1]?.textContent).toContain("its author restacks it locally");
    expect(rows[2]?.textContent).toContain("The branch already holds its new base");
  });
});

describe("an open restack panel", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a restack queued after it opened, and follows it to its end", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let jobs: RestackJobView[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ restack: true, jobs })),
    );
    render(<RepoRestack r={{ ...repo, restack: true }} onChanged={() => {}} />);
    expect(await screen.findByText("No restacks yet.")).toBeTruthy();
    jobs = [job({ state: "queued", outcome: null, to: null, finishedAt: null })];
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole("listitem").textContent).toContain("Queued");
    jobs = [job({})];
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(screen.getByRole("listitem").textContent).toContain("Restacked");
  });
});
