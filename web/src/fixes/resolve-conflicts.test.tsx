import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MendConflictView, PullMendView } from "../../../src/shared/index.js";
import { ResolveConflicts } from "./resolve-conflicts.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = { platform: "github", repo: "octo/api", number: 7 };
const mend = (over: Partial<PullMendView> = {}): PullMendView => ({
  level: "commit",
  loop: null,
  items: [],
  checks: [],
  conflicts: [],
  resolves: true,
  suggests: false,
  ...over,
});
const QUEUED = { state: "queued", outcome: null, error: null, finishedAt: null } as const;

/** Answers the loop with `views` in turn (the last one stays), and keeps what was posted. */
function serve(views: PullMendView[], refuse?: number) {
  const posted: unknown[] = [];
  let read = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push([url, JSON.parse(String(init.body))]);
        return refuse
          ? Response.json({ error: "daily_limit", limit: 30 }, { status: refuse })
          : Response.json({ outcome: "queued", mend: views.at(-1) });
      }
      return Response.json(views[Math.min(read++, views.length - 1)]);
    }),
  );
  return posted;
}

const show = async (onChanged = () => {}) => {
  await act(async () => void render(<ResolveConflicts pull={pull} onChanged={onChanged} />));
};
const click = () => act(async () => void fireEvent.click(screen.getByRole("button")));

it("offers nothing where the repository is not enrolled", async () => {
  serve([mend({ level: null, resolves: false })]);
  await show();
  expect(screen.queryByRole("button")).toBeNull();
});

it("asks for the conflicts, says what ocra will do, and then that it waits", async () => {
  const posted = serve([mend(), mend({ loop: QUEUED })]);
  await show();
  expect(screen.getByText(/It never rebases or force-pushes/)).toBeTruthy();
  await click();
  expect(posted).toEqual([["/api/auto-review/mends/conflicts", pull]]);
  expect(screen.getByRole("status").textContent).toBe("Queued for ocra");
  expect(screen.queryByRole("button")).toBeNull();
});

it("says which file the last round left to a person, and offers to try again", async () => {
  serve([
    mend({
      conflicts: [
        { path: "src/a.ts", outcome: "deferred", reason: "conflicts", cause: null, regions: [] },
        { path: "src/db.ts", outcome: "needs_human", reason: "unsure", cause: null, regions: [] },
      ],
    }),
  ]);
  await show();
  expect(screen.getByRole("button").textContent).toBe("Try resolving the conflicts again");
  expect(screen.getByRole("status").textContent).toBe(
    "ocra left the merge to a person: src/db.ts, ocra could not tell that its resolution was right.",
  );
});

it("says when the day's requests are used up", async () => {
  serve([mend()], 429);
  await show();
  await click();
  expect(screen.getByRole("alert").textContent).toMatch(/fixes are used up/);
});

const SUGGESTS = { level: "propose", resolves: false, suggests: true } as const;
const proposed: MendConflictView = {
  path: "limits.ts",
  outcome: "proposed",
  reason: null,
  cause: null,
  regions: [
    {
      line: 3,
      ours: "export const MAX_QUERY_PARAMS = 32;",
      theirs: "export const MAX_COOKIES = 50;",
      resolved: "export const MAX_QUERY_PARAMS = 32;\nexport const MAX_COOKIES = 50;",
    },
  ],
};

it("asks only for a suggestion where the repository does not let ocra merge its base branch", async () => {
  const posted = serve([mend(SUGGESTS), mend({ ...SUGGESTS, loop: QUEUED })]);
  await show();
  expect(screen.getByRole("button").textContent).toBe("Suggest a resolution");
  expect(screen.getByText(/writes nothing to this branch/)).toBeTruthy();
  await click();
  expect(posted).toEqual([["/api/auto-review/mends/conflicts", pull]]);
  expect(screen.getByRole("status").textContent).toBe("Queued for ocra");
});

it("shows each suggested region with both sides, and says nothing was written", async () => {
  serve([mend({ ...SUGGESTS, conflicts: [proposed] })]);
  await show();
  expect(screen.getByRole("button").textContent).toBe("Suggest a resolution again");
  expect(screen.getByText(/Nothing was written to the branch/)).toBeTruthy();
  expect(screen.queryByText(/left the merge to a person/)).toBeNull();
  const suggested = screen.getByRole("region", {
    name: "Suggested lines of limits.ts from line 3",
  });
  expect(suggested.textContent).toBe(
    "export const MAX_QUERY_PARAMS = 32;\nexport const MAX_COOKIES = 50;",
  );
  expect(
    screen.getByRole("region", { name: "The base branch's lines of limits.ts" }).textContent,
  ).toBe("export const MAX_COOKIES = 50;");
});
