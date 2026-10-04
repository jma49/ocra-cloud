import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effortLevels } from "../src/capabilities.js";
import { parseAgents } from "../src/preferences.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const json = { "content-type": "application/json" };

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

describe("per-agent settings", () => {
  it("accept reviewers, roles and tier efforts, and drop empty entries", () => {
    expect(
      parseAgents({
        effort: { standard: "medium", top: "" },
        reviewers: {
          security: { models: ["ocra-openrouter/anthropic/claude-sonnet-5"], effort: "high" },
          docs: { enabled: false },
          performance: {},
        },
        roles: {
          judge: { effort: "high" },
          helper: { models: "ocra-openrouter/qwen/qwen3.8-27b:free" },
        },
      }),
    ).toEqual({
      effort: { standard: "medium" },
      reviewers: {
        security: { models: ["ocra-openrouter/anthropic/claude-sonnet-5"], effort: "high" },
        docs: { enabled: false },
      },
      roles: {
        judge: { effort: "high" },
        helper: { models: ["ocra-openrouter/qwen/qwen3.8-27b:free"] },
      },
    });
  });

  it("refuse unknown levels, models outside ocra Cloud, role names as reviewers and odd ids", () => {
    for (const bad of [
      { effort: { standard: "max" } },
      { reviewers: { security: { models: ["anthropic/claude"] } } },
      { reviewers: { judge: { effort: "low" } } },
      { reviewers: { "Bad Id": {} } },
      { reviewers: { docs: { enabled: "no" } } },
      { roles: { planner: { effort: "low" } } },
      {
        roles: { judge: { models: ["ocra-a/1", "ocra-a/2", "ocra-a/3", "ocra-a/4", "ocra-a/5"] } },
      },
    ]) {
      expect(parseAgents(bad)).toBeUndefined();
    }
  });

  it("are saved on the web and read by the CLI, with the runtime and tier models", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const body = {
      runtime: "direct",
      models: { standard: ["ocra-openrouter/m"] },
      agents: { reviewers: { security: { effort: "high" } } },
    };
    const put = await call("/api/preferences", {
      method: "PUT",
      headers: { ...web.auth, ...json },
      body: JSON.stringify(body),
    });
    expect(put.status).toBe(200);
    expect(await (await call("/api/preferences", { headers: cli.auth })).json()).toEqual(body);
    // The 0.4.0 CLI's endpoint keeps answering with the tier models.
    expect(await (await call("/api/preferences/models", { headers: cli.auth })).json()).toEqual({
      models: { standard: ["ocra-openrouter/m"] },
    });
    const bad = await call("/api/preferences", {
      method: "PUT",
      headers: { ...web.auth, ...json },
      body: JSON.stringify({ ...body, runtime: "docker" }),
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await call("/api/preferences", {
          method: "PUT",
          headers: { ...cli.auth, ...json },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
});

describe("model lists with effort levels", () => {
  it("reads reasoning support from OpenRouter's list", async () => {
    const web = await signIn(1, "octo");
    vi.spyOn(globalThis, "fetch")
      .mockClear()
      .mockImplementation(async () => Response.json({}));
    await call("/api/keys/openrouter", {
      method: "PUT",
      headers: { ...web.auth, ...json },
      body: JSON.stringify({ key: "sk-or-0123456789" }),
    });
    vi.spyOn(globalThis, "fetch")
      .mockClear()
      .mockImplementation(async () =>
        Response.json({
          data: [
            { id: "qwen/qwen3.8-27b:free", supported_parameters: ["reasoning", "tools"] },
            { id: "openai/gpt-4o", supported_parameters: ["tools"] },
          ],
        }),
      );
    const res = await call("/api/keys/openrouter/models", { headers: web.auth });
    expect(await res.json()).toEqual({
      provider: "openrouter",
      models: [
        { id: "openai/gpt-4o", efforts: [] },
        { id: "qwen/qwen3.8-27b:free", efforts: ["low", "medium", "high"] },
      ],
    });
  });
});
