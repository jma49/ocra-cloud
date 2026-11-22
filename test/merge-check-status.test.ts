import { describe, expect, it } from "vitest";
import { statusOf } from "../src/merge-checks/run.js";
import type { MergeCheckResultView } from "../src/shared/index.js";

// What the platform shows of a pull request's checks: a GitLab commit
// status has only its one-line title, so the title names what is not known yet.

const result = (over: Partial<MergeCheckResultView>): MergeCheckResultView => ({
  id: "c1",
  kind: "linked_issue",
  mode: "block",
  outcome: "passed",
  detail: "links #12",
  ...over,
});
const title = (results: MergeCheckResultView[], conclusion: "success" | "pending" = "success") =>
  statusOf({ head: "a".repeat(40), conclusion, results }, "https://ocra.example/p").title;

describe("the posted title of a pull request's checks", () => {
  it("says checks are not evaluated yet rather than that all passed", () => {
    const waiting = result({ outcome: "not_evaluated", detail: "not evaluated yet" });
    expect(title([waiting])).toBe("1 check not evaluated yet");
    expect(title([waiting, { ...waiting, id: "c2" }, result({ id: "c3" })])).toBe(
      "2 checks not evaluated yet",
    );
  });

  it("says all passed only when every check passed", () => {
    expect(title([result({}), result({ id: "c2", kind: "title" })])).toBe("All checks passed");
  });

  it("leads with failures over checks not evaluated", () => {
    const waiting = result({ id: "c2", outcome: "not_evaluated", detail: "not evaluated yet" });
    expect(title([result({ outcome: "failed", detail: "no linked issue" }), waiting])).toBe(
      "1 blocking check failed",
    );
    expect(title([result({ mode: "warn", outcome: "failed" }), waiting])).toBe(
      "Passed with 1 warning",
    );
  });

  it("says a pending head waits for its review, even with a warning failed", () => {
    const waiting = result({ outcome: "not_evaluated", detail: "not evaluated yet" });
    const warned = result({ id: "c2", mode: "warn", outcome: "failed" });
    expect(title([waiting, warned], "pending")).toBe(
      "Waiting for the review: 1 check not evaluated yet",
    );
  });
});
