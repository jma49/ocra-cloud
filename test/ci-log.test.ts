import { describe, expect, it } from "vitest";
import { CHECK_LOG_LIMITS, checkLogTail } from "../src/platforms/ci-log.js";

// The mirror of the contract's checkLogTail (0.23.1): the same steps and limits.

describe("checkLogTail", () => {
  it("splits on CRLF and LF and drops empty lines", () => {
    expect(checkLogTail("a\r\nb\n\n   \nc\n")).toBe("a\nb\nc");
  });

  it("strips ANSI sequences, then control characters but tab, then a leading timestamp", () => {
    expect(checkLogTail("2026-11-24T10:00:00.1234567Z \u001b[1;31merror\u001b[0m\tx\u0007")).toBe(
      "error\tx",
    );
    expect(checkLogTail("2026-11-24T10:00:00+08:00 ok")).toBe("ok");
    expect(checkLogTail("a\u2028b\u2029c\u009b")).toBe("abc");
  });

  it("removes a timestamp only at the start of a line, after the sequences before it", () => {
    expect(checkLogTail("\u001b[0K2026-11-24T10:00:00Z step")).toBe("step");
    expect(checkLogTail("at 2026-11-24T10:00:00Z step")).toBe("at 2026-11-24T10:00:00Z step");
  });

  it("trims the end of each line, so a line of spaces is dropped", () => {
    expect(checkLogTail("x   \n \t \ny")).toBe("x\ny");
  });

  it("keeps the last 200 lines, then the last 20,000 characters", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const kept = checkLogTail(lines.join("\n")).split("\n");
    expect(kept).toHaveLength(CHECK_LOG_LIMITS.lines);
    expect(kept[0]).toBe("line 50");
    const long = Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(4_999)}`).join("\n");
    const cut = checkLogTail(long);
    expect(cut).toHaveLength(CHECK_LOG_LIMITS.chars);
    expect(cut.endsWith(`9${"x".repeat(4_999)}`)).toBe(true);
  });

  it("keeps an Actions log from the failed step's start through its last error", () => {
    const log = [
      "##[group]Run npm ci",
      "added 10 packages",
      "##[group]Run npm test",
      "##[error]first",
      "FAIL a.test.ts",
      "##[error]Process completed with exit code 1.",
      "Post job cleanup.",
      "##[group]Run actions/checkout@v4",
    ].join("\n");
    expect(checkLogTail(log)).toBe(
      "##[group]Run npm test\n##[error]first\nFAIL a.test.ts\n##[error]Process completed with exit code 1.",
    );
  });

  it("keeps a GitLab trace's last script section, its marks on their own lines", () => {
    const log =
      "section_start:1:step_script\r\u001b[0KExecuting\n$ npm test\nFAIL\nsection_end:2:step_script\r\u001b[0Ksection_start:3:after_script\r\u001b[0Kafter\n";
    expect(checkLogTail(log)).toBe("Executing\n$ npm test\nFAIL");
  });
});
