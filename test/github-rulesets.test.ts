import { describe, expect, it } from "vitest";
import { type GithubRule, strictest } from "../src/platforms/github-rulesets.js";

const rule = (r: Partial<GithubRule>): GithubRule => ({
  requiresApprovingReviews: false,
  requiredApprovingReviewCount: 0,
  requiresCodeOwnerReviews: false,
  dismissesStaleReviews: false,
  requiresStatusChecks: false,
  requiredStatusCheckContexts: [],
  ...r,
});

describe("the strictest of two branch rules", () => {
  it("takes the higher count, either's requirement and every check, in either order", () => {
    const a = rule({
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 1,
      requiresCodeOwnerReviews: true,
      requiresStatusChecks: true,
      requiredStatusCheckContexts: ["ci", null],
    });
    const b = rule({
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 3,
      dismissesStaleReviews: true,
      requiresConversationResolution: true,
      requiredStatusCheckContexts: ["ci", "e2e"],
    });
    const want = {
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 3,
      requiresCodeOwnerReviews: true,
      dismissesStaleReviews: true,
      requiresStatusChecks: true,
      requiredStatusCheckContexts: ["ci", "e2e"],
      requiresConversationResolution: true,
    };
    expect(strictest(a, b)).toEqual(want);
    expect(strictest(b, a)).toEqual({ ...want, requiredStatusCheckContexts: ["ci", "e2e"] });
    expect(strictest(null, a)).toBe(a);
    expect(strictest(null, null)).toBeNull();
  });
});
