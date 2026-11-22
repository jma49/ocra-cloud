import {
  MERGE_CHECK_ID,
  mergeCheckSchema,
  type SharedMergeCheck,
} from "@open-cr-agent/cloud-contract";
import fixture from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { describe, expect, it } from "vitest";
import { type CheckConfig, evaluateChecks, type HeadReview } from "../src/merge-checks/evaluate.js";
import {
  engineMergeChecks,
  instructionCheckId,
  judgeInstruction,
  withEngineIds,
} from "../src/merge-checks/instruction.js";
import type { PullFacts } from "../src/platforms/merge-status.js";

// Plain-language checks: given to the hosted review under an id that
// follows their text, and judged from the head's review's verdicts under
// that id only.

const ROW = "6a6e099a-5910-4b94-a23a-709ba6decb87";
const facts: PullFacts = {
  title: "feat: retry",
  description: "## Why\nRetries.",
  head: "a".repeat(40),
  files: 1,
  lines: 4,
  exact: true,
};
const instruction = (text: string, mode: CheckConfig["mode"] = "block", id = ROW): CheckConfig => ({
  id,
  kind: "instruction",
  mode,
  settings: { text },
});
const [uploaded] = fixture.mergeChecks;

describe("a plain-language check's id", () => {
  it("fits the contract and changes when, and only when, the text does", async () => {
    const id = await instructionCheckId(ROW, "Say how often a query retries");
    expect(id).toMatch(MERGE_CHECK_ID);
    expect(id.startsWith(`${ROW}.`)).toBe(true);
    expect(await instructionCheckId(ROW, "Say how often a query retries")).toBe(id);
    expect(await instructionCheckId(ROW, "Say how often a query retries.")).not.toBe(id);
  });

  it("is given to the review for each enabled instruction, in the contract's shape", async () => {
    const given = await engineMergeChecks([
      instruction("No new globals"),
      instruction("Name the migration", "off", "row-off"),
      instruction("Name the ticket", "warn", "row-warn"),
      { id: "row-title", kind: "title", mode: "block", settings: { prefixes: ["feat"] } },
      { id: "row-bad", kind: "instruction", mode: "block", settings: { text: "" } },
    ]);
    expect(given).toEqual([
      { id: await instructionCheckId(ROW, "No new globals"), instruction: "No new globals" },
      {
        id: await instructionCheckId("row-warn", "Name the ticket"),
        instruction: "Name the ticket",
      },
    ]);
    for (const check of given) expect(mergeCheckSchema.parse(check)).toEqual(check);
  });
});

describe("judging a plain-language check", () => {
  const verdict = (outcome: "passed" | "failed" | "inconclusive", reason?: string) => ({
    id: "c.1",
    outcome,
    ...(reason ? { reason } : {}),
  });

  it("passes or fails as the review judged it, with its reason on one line", () => {
    expect(judgeInstruction("c.1", [null, verdict("passed")])).toEqual({
      outcome: "passed",
      detail: "the change follows the instruction",
    });
    expect(judgeInstruction("c.1", [verdict("failed", "No retry\n  count.")])).toEqual({
      outcome: "failed",
      detail: "No retry count.",
    });
    expect(judgeInstruction("c.1", [verdict("failed", "x".repeat(400))]).detail).toHaveLength(300);
  });

  it("waits when the review could not tell, judged none, or judged another text", () => {
    expect(judgeInstruction("c.1", [verdict("inconclusive")]).outcome).toBe("not_evaluated");
    expect(judgeInstruction("c.1", undefined).outcome).toBe("not_evaluated");
    expect(judgeInstruction("c.1", []).outcome).toBe("not_evaluated");
    expect(judgeInstruction("c.2", [verdict("failed")]).outcome).toBe("not_evaluated");
    expect(judgeInstruction(undefined, [verdict("failed")]).outcome).toBe("not_evaluated");
  });

  it("fails the pull request at its mode, and ignores a verdict on the old text", async () => {
    const text = "Say how often a query retries";
    const review = (id: string): HeadReview => ({
      unresolvedCritical: 0,
      mergeChecks: [{ ...(uploaded as SharedMergeCheck), id }],
    });
    const [blocking] = await withEngineIds([instruction(text)]);
    const current = blocking?.engineId ?? "";
    const [warning] = await withEngineIds([instruction(text, "warn")]);
    if (!blocking || !warning) throw new Error("no checks");
    expect(evaluateChecks([blocking], facts, review(current))).toMatchObject({
      conclusion: "failure",
      results: [{ outcome: "failed", detail: uploaded?.reason }],
    });
    expect(evaluateChecks([warning], facts, review(current)).conclusion).toBe("neutral");

    const [edited] = await withEngineIds([instruction(`${text}, and why`)]);
    if (!edited) throw new Error("no check");
    const stale = evaluateChecks([edited], facts, review(current));
    expect(stale).toMatchObject({ conclusion: "success", results: [{ outcome: "not_evaluated" }] });
    expect(evaluateChecks([blocking], facts, { unresolvedCritical: 0 })).toMatchObject({
      conclusion: "success",
      results: [{ outcome: "not_evaluated" }],
    });
  });
});
