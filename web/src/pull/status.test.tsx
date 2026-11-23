import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PullReadinessView, QueueState } from "../../../src/shared/index.js";
import { PullStatus } from "./status.js";

afterEach(cleanup);

const READY = { ready: "met", items: [] } as unknown as PullReadinessView;

const said = (queued: QueueState | null, state: "open" | "merged" = "open") => {
  cleanup();
  const { container } = render(<PullStatus state={state} view={READY} queued={queued} />);
  return [...container.querySelectorAll("span")].map((b) => [b.textContent, b.className]);
};

it("says where a queued pull request stands in the queue, not that it is ready to merge", () => {
  expect(said(null)).toEqual([["Ready to merge", "pull-state is-ok"]]);
  expect(said("waiting")).toEqual([["Queued", "pull-state"]]);
  expect(said("checking")).toEqual([["Checks running", "pull-state is-run"]]);
  expect(said("merging", "merged")).toEqual([["Merged", "pull-state is-ok"]]);
});

it("marks conflicts in the error colour beside a draft's quiet word", () => {
  const view = {
    ready: "unmet",
    items: [
      { kind: "draft", state: "unmet" },
      { kind: "conflicts", state: "unmet" },
    ],
  } as unknown as PullReadinessView;
  const { container } = render(<PullStatus state="open" view={view} queued={null} />);
  expect([...container.querySelectorAll("span")].map((b) => [b.textContent, b.className])).toEqual([
    ["Draft", "pull-state"],
    ["Conflicts", "pull-state is-err"],
  ]);
});
