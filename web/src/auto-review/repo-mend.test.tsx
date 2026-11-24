import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AutoReviewRepoView } from "../../../src/shared/index.js";
import { RepoMend } from "./repo-mend.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const repo = {
  id: "p1",
  fullName: "octo/api",
  mend: "propose",
  mendChecks: false,
  mendConflicts: false,
} as AutoReviewRepoView;

/** Takes the level unless `refuse`, and keeps what was put. */
function serve(refuse = false) {
  const put: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== "/api/auto-review/repos/p1/mend" || init?.method !== "PUT") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const body = JSON.parse(String(init.body));
      put.push(body);
      return refuse
        ? Response.json({ error: "rate_limited" }, { status: 429 })
        : Response.json({
            mend: body.mend,
            checks: body.mend === "commit" && body.checks,
            conflicts: body.mend === "commit" && body.conflicts,
          });
    }),
  );
  return put;
}

const COMMITS = "Commit ocra's fixes in octo/api to the branch";
const CHECKS = "Fix failed checks in octo/api";
const CONFLICTS = "Resolve merge conflicts in octo/api";
const flip = (name = COMMITS) =>
  act(async () => void fireEvent.click(screen.getByRole("switch", { name })));

it("starts with ocra proposing, and says what committing does once it is switched on", async () => {
  const put = serve();
  const changed = vi.fn();
  render(<RepoMend r={repo} onChanged={changed} />);
  const box = screen.getByRole("switch", { name: "Commit ocra's fixes in octo/api to the branch" });
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(/a person commits it/)).toBeTruthy();
  await flip();
  expect(put).toEqual([{ mend: "commit", checks: false, conflicts: false }]);
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/It runs nothing from the repository/)).toBeTruthy();
  expect(changed).toHaveBeenCalledOnce();
  await flip();
  expect(put.at(-1)).toEqual({ mend: "propose", checks: false, conflicts: false });
});

it("offers fixing failed checks only where ocra commits, and turns it off with that", async () => {
  const put = serve();
  render(<RepoMend r={repo} onChanged={() => {}} />);
  expect(screen.queryByRole("switch", { name: CHECKS })).toBeNull();
  await flip();
  expect(screen.getByText("ocra fixes only what someone asks it to.")).toBeTruthy();
  await flip(CHECKS);
  expect(put.at(-1)).toEqual({ mend: "commit", checks: true, conflicts: false });
  expect(screen.getByRole("switch", { name: CHECKS }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/without being asked/)).toBeTruthy();
  await flip();
  expect(put.at(-1)).toEqual({ mend: "propose", checks: false, conflicts: false });
  expect(screen.queryByRole("switch", { name: CHECKS })).toBeNull();
});

it("offers resolving merge conflicts only where ocra commits, and says it never rebases", async () => {
  const put = serve();
  render(<RepoMend r={repo} onChanged={() => {}} />);
  expect(screen.queryByRole("switch", { name: CONFLICTS })).toBeNull();
  await flip();
  expect(screen.getByText("ocra leaves merge conflicts to a person.")).toBeTruthy();
  await flip(CONFLICTS);
  expect(put.at(-1)).toEqual({ mend: "commit", checks: false, conflicts: true });
  expect(screen.getByText(/It never rebases or force-pushes/)).toBeTruthy();
  await flip();
  expect(put.at(-1)).toEqual({ mend: "propose", checks: false, conflicts: false });
});

it("puts the switch back when the server refuses", async () => {
  serve(true);
  const changed = vi.fn();
  render(<RepoMend r={repo} onChanged={changed} />);
  await flip();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("alert").textContent).toMatch(/^Could not change it: /);
  expect(changed).not.toHaveBeenCalled();
});
