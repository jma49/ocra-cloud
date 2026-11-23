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
  expect(said(null)).toEqual([["Ready to merge", "badge badge-ok"]]);
  expect(said("waiting")).toEqual([["Queued", "badge"]]);
  expect(said("checking")).toEqual([["Checks running", "badge badge-run"]]);
  expect(said("merging", "merged")).toEqual([["Merged", "badge badge-ok"]]);
});
