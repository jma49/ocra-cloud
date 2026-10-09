import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { DAY, secondsToNextUtcDay, utcDay, utcDayStart } from "../src/time.js";

describe("time", () => {
  it("counts days in UTC", () => {
    const late = new Date("2026-10-04T23:59:59.999Z");
    expect(utcDay(late)).toBe("2026-10-04");
    expect(utcDayStart(late)).toEqual(new Date("2026-10-04T00:00:00Z"));
    expect(utcDayStart(new Date(late.getTime() + 1)).getTime() - utcDayStart(late).getTime()).toBe(
      DAY,
    );
  });
});

describe("retry-after for a daily limit", () => {
  it("is the whole seconds to the next midnight UTC, at least one", () => {
    expect(secondsToNextUtcDay(new Date("2026-10-04T00:00:00Z"))).toBe(86_400);
    expect(secondsToNextUtcDay(new Date("2026-10-04T23:00:00.500Z"))).toBe(3_600);
    expect(secondsToNextUtcDay(new Date("2026-10-04T23:59:59.999Z"))).toBe(1);
  });
});

describe("config", () => {
  it("parses the numeric vars once per environment", () => {
    const env = {
      GATEWAY_DAILY_CALLS: "3",
      REVIEW_DAILY_UPLOADS: "500",
      REVIEW_MAX_FINDINGS: "20000",
      DEVICE_DAILY_CODES: "50",
      DEVICE_DAILY_CODES_PER_NETWORK: "5",
    };
    const first = config(env);
    expect(first).toEqual({
      gatewayDailyCalls: 3,
      reviewDailyUploads: 500,
      reviewMaxFindings: 20000,
      deviceDailyCodes: 50,
      deviceDailyCodesPerNetwork: 5,
    });
    expect(config(env)).toBe(first);
    expect(config({ ...env, GATEWAY_DAILY_CALLS: "7" }).gatewayDailyCalls).toBe(7);
  });
});
