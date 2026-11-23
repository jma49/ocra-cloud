import { describe, expect, it } from "vitest";
import { slackDmOutcome } from "../src/notify/slack-dm.js";

// What Slack answers a direct message: its rate limit and its own failures
// are tried again, any other error it names is given up at once.

describe("a Slack direct message's answer", () => {
  it("is read as retry or give up", () => {
    expect(slackDmOutcome(200, { ok: true })).toMatchObject({ error: null });
    expect(slackDmOutcome(429, {})).toMatchObject({ transient: true });
    expect(slackDmOutcome(503, {})).toMatchObject({ transient: true });
    for (const error of ["ratelimited", "internal_error", "service_unavailable"]) {
      expect(slackDmOutcome(200, { ok: false, error })).toMatchObject({ transient: true });
    }
    for (const error of ["account_inactive", "channel_not_found", "invalid_auth", "not_authed"]) {
      expect(slackDmOutcome(200, { ok: false, error })).toMatchObject({
        error: "rejected",
        transient: false,
      });
    }
    expect(slackDmOutcome(302, {})).toMatchObject({ error: "redirect", transient: false });
  });
});
