import { describe, expect, it } from "vitest";
import { effortLevels } from "../src/shared/index.js";

describe("effort levels by model", () => {
  it("knows the common reasoning models and nothing else", () => {
    expect(effortLevels("gpt-5.5")).toEqual(["minimal", "low", "medium", "high"]);
    expect(effortLevels("openai/o4-mini")).toEqual(["minimal", "low", "medium", "high"]);
    expect(effortLevels("claude-sonnet-5-5")).toEqual(["low", "medium", "high"]);
    expect(effortLevels("anthropic/claude-opus-4.6")).toEqual(["low", "medium", "high"]);
    expect(effortLevels("gemini-3.5-flash")).toEqual(["none", "low", "medium", "high"]);
    expect(effortLevels("x-ai/grok-4")).toEqual(["low", "high"]);
    expect(effortLevels("deepseek-chat")).toEqual([]);
    expect(effortLevels("gpt-4o")).toEqual([]);
  });

  it("lets OpenRouter's live data win over the table", () => {
    expect(effortLevels("gpt-4o", { reasoning: true })).toEqual(["low", "medium", "high"]);
    expect(effortLevels("gpt-5.5", { reasoning: false })).toEqual([]);
  });
});
