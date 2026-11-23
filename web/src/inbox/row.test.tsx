import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PullRow } from "./row.js";
import type { Row } from "./sections.js";

afterEach(cleanup);

const row = (over: Partial<Row>): Row => ({
  platform: "github",
  host: "github.com",
  id: "1",
  number: 1,
  title: "Cap refunds",
  url: "https://github.com/octo/api/pull/1",
  repo: "octo/api",
  author: "ada",
  draft: false,
  state: "open",
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-21T10:00:00Z",
  mergedAt: null,
  roles: ["author"],
  checks: null,
  review: null,
  labels: [],
  verdict: null,
  additions: null,
  deletions: null,
  head: null,
  unread: false,
  repliesWaiting: 0,
  ...over,
});

const standing = (over: Partial<Row>) => {
  cleanup();
  render(
    <PullRow
      r={row(over)}
      i={0}
      current={false}
      run={null}
      onOpen={() => undefined}
      onMark={() => undefined}
    />,
  );
  return document.querySelector(".pull-review")?.textContent;
};

it("says the one thing to know before opening a pull request", () => {
  expect(standing({})).toBe("");
  expect(standing({ draft: true, verdict: "blocking", review: "required" })).toBe("Draft");
  expect(standing({ verdict: "blocking", review: "approved" })).toBe("ocra blocks");
  expect(screen.getByText("ocra blocks").className).toContain("badge-err");
  expect(standing({ verdict: "not_blocking", review: "changes_requested" })).toBe(
    "Changes requested",
  );
  expect(standing({ verdict: "not_blocking" })).toBe("ocra passed");
  expect(standing({ state: "merged", draft: true, verdict: "blocking" })).toBe("");
});
