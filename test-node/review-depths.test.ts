import { configSchema, REVIEW_DEPTHS as ENGINE_DEPTHS } from "@open-cr-agent/cloud-contract";
import {
  agentsMdReviewerPlugin,
  correctnessReviewerPlugin,
  docsReviewerPlugin,
  performanceReviewerPlugin,
  securityReviewerPlugin,
} from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { depthRun } from "../src/auto-review/depths.js";
import { DEFAULT_REVIEW_DEPTH, REVIEW_DEPTHS } from "../src/shared/index.js";

// A review depth only sets what the pinned engine already reads: each
// one's configuration fits the engine's schema, and names its reviewers.

const engineReviewers = () => {
  const ids: string[] = [];
  const ctx = {
    registerReviewer: (r: { id: string }) => {
      ids.push(r.id);
    },
  };
  for (const plugin of [
    correctnessReviewerPlugin,
    securityReviewerPlugin,
    performanceReviewerPlugin,
    docsReviewerPlugin,
    agentsMdReviewerPlugin,
  ]) {
    // Only registerReviewer is called by a reviewer plugin.
    (plugin.configure as unknown as (c: typeof ctx) => void)(ctx);
  }
  return ids;
};

describe("a hosted review's depth", () => {
  it("is standard by default, which sets nothing: today's review", () => {
    expect(DEFAULT_REVIEW_DEPTH).toBe("standard");
    expect(depthRun("standard")).toEqual({ config: {}, flags: [] });
  });

  it("names the engine's depths, in its order", () => {
    expect(REVIEW_DEPTHS).toEqual(ENGINE_DEPTHS);
  });

  it("maps quick to the engine's quick, held to correctness and security on changed lines, at most ten warnings or worse inline, without ultra; deep to the engine's deep with --ultra", () => {
    expect(depthRun("quick")).toEqual({
      config: {
        reviewers: {
          performance: { enabled: false },
          docs: { enabled: false },
          "agents-md": { enabled: false },
        },
        showPreExisting: false,
        minInlineSeverity: "warning",
        maxInlineComments: 10,
        ultra: false,
      },
      flags: ["--depth", "quick"],
    });
    expect(depthRun("deep")).toEqual({ config: {}, flags: ["--depth", "deep", "--ultra"] });
  });

  it("writes only configuration the engine accepts, naming its own reviewers", () => {
    const known = engineReviewers();
    expect(known).toEqual(expect.arrayContaining(["correctness", "security"]));
    for (const depth of REVIEW_DEPTHS) {
      const { config } = depthRun(depth);
      expect(configSchema.safeParse(config).success).toBe(true);
      for (const id of Object.keys(config.reviewers ?? {})) expect(known).toContain(id);
    }
  });
});
