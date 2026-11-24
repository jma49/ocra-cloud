import { describe, expect, it } from "vitest";
import { CHECK_LOG_LIMITS, checkLogTail } from "../src/platforms/ci-log.js";

// The mirror of the contract's checkLogTail (0.23.0): the same steps and limits.

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
});
