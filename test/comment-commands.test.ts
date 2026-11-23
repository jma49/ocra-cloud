import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/auto-review/commands.js";

// What makes an @ocra comment a command rather than a question.

describe("reading a command", () => {
  it("takes a line that is only the mention and a command word", () => {
    expect(parseCommand("@ocra review")).toBe("review");
    expect(parseCommand("Thanks!\n  @OCRA Pause.  \nlater")).toBe("pause");
    expect(parseCommand("@ocra generate   tests")).toBe("generate_tests");
    expect(parseCommand("@ocra generate docstrings")).toBe("generate_docstrings");
    expect(parseCommand("@ocra help!")).toBe("help");
  });

  it("leaves a question, an unknown word, a quote and a code block to the question path", () => {
    for (const body of [
      "@ocra review this function, is it safe?",
      "@ocra frobnicate",
      "@ocra generate poems",
      "> @ocra pause",
      "```\n@ocra resolve\n```",
      "please @ocra resume",
    ]) {
      expect(parseCommand(body)).toBeNull();
    }
  });
});
