import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PullFilesView } from "../../../src/shared/index.js";
import { MergeNow } from "./merge-now.js";

afterEach(cleanup);

const data = {
  url: "https://github.com/octo/api/pull/13",
  head: "a".repeat(40),
} as unknown as PullFilesView;
const pull = { platform: "github" as const, repo: "octo/api", number: 13 };

const merge = (conflicts: boolean) => {
  cleanup();
  render(
    <MergeNow
      data={data}
      pull={pull}
      method="merge"
      primary={false}
      conflicts={conflicts}
      onDone={() => undefined}
    />,
  );
  return screen.getByRole("button", { name: "Merge pull request" }) as HTMLButtonElement;
};

it("holds merge now while the pull request conflicts with its base, and says where to resolve it", () => {
  expect(merge(true).disabled).toBe(true);
  expect(screen.getByRole("link", { name: "on the platform" }).getAttribute("href")).toBe(
    "https://github.com/octo/api/pull/13/conflicts",
  );
  expect(merge(false).disabled).toBe(false);
  expect(screen.queryByRole("link", { name: "on the platform" })).toBeNull();
});
