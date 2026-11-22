import {
  agentsMdReviewerPlugin,
  correctnessReviewerPlugin,
  docsReviewerPlugin,
  performanceReviewerPlugin,
  securityReviewerPlugin,
} from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { profileRun } from "../src/auto-review/profiles.js";
import { CONFIG_JSON_SCHEMA } from "../src/engine-schemas.js";
import { DEFAULT_REVIEW_PROFILE, REVIEW_PROFILES } from "../src/shared/index.js";

// A review profile only sets what the pinned engine already reads: each
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

describe("a hosted review's profile", () => {
  it("is balanced by default, which sets nothing: today's review", () => {
    expect(DEFAULT_REVIEW_PROFILE).toBe("balanced");
    expect(profileRun("balanced")).toEqual({ config: {}, flags: [] });
  });

  it("maps quiet to correctness and security on changed lines, thorough to --ultra", () => {
    expect(profileRun("quiet")).toEqual({
      config: {
        reviewers: {
          performance: { enabled: false },
          docs: { enabled: false },
          "agents-md": { enabled: false },
        },
        showPreExisting: false,
      },
      flags: [],
    });
    expect(profileRun("thorough")).toEqual({ config: {}, flags: ["--ultra"] });
  });

  it("writes only configuration the engine accepts, naming its own reviewers", () => {
    const schema = z.fromJSONSchema(CONFIG_JSON_SCHEMA as z.core.JSONSchema.JSONSchema);
    const known = engineReviewers();
    expect(known).toEqual(expect.arrayContaining(["correctness", "security"]));
    for (const profile of REVIEW_PROFILES) {
      const { config } = profileRun(profile);
      expect(schema.safeParse(config).success).toBe(true);
      for (const id of Object.keys(config.reviewers ?? {})) expect(known).toContain(id);
    }
  });
});
