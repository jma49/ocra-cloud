import { describe, expect, it } from "vitest";
import { currentStep, type SetupFacts, setupSteps } from "./steps.js";

const github = (over: Partial<SetupFacts["platforms"][number]> = {}) => ({
  platform: "github" as const,
  linked: true,
  installUrl: "https://github.com/apps/ocra-cloud/installations/new",
  repositories: [],
  ...over,
});
const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  hosted: true,
  platforms: [github({ linked: false })],
  keys: 0,
  enrolled: 0,
  cliSignedIn: false,
  reviews: 0,
  ...over,
});
const now = (f: SetupFacts) => currentStep(setupSteps(f))?.key;

describe("setting up a server that reviews", () => {
  it("goes connect, choose, key, enroll, then the first review", () => {
    expect(now(facts())).toBe("connect");
    expect(now(facts({ platforms: [github()] }))).toBe("choose");
    const chosen = [github({ repositories: [{}] })];
    expect(now(facts({ platforms: chosen }))).toBe("key");
    expect(now(facts({ platforms: chosen, keys: 1 }))).toBe("enroll");
    expect(now(facts({ platforms: chosen, keys: 1, enrolled: 1 }))).toBe("review");
    expect(now(facts({ platforms: chosen, keys: 1, enrolled: 1, reviews: 1 }))).toBeUndefined();
  });

  it("sends choosing repositories to the app's installation page", () => {
    const choose = setupSteps(facts({ platforms: [github()] })).find((s) => s.key === "choose");
    expect(choose).toMatchObject({ external: true, label: "Choose repositories" });
    expect(choose?.to).toMatch(/installations\/new$/);
  });

  it("asks for a key before the step it was skipped for, whatever came after", () => {
    expect(now(facts({ platforms: [github({ repositories: [{}] })], enrolled: 1 }))).toBe("key");
  });
});

describe("setting up a server without hosted reviews", () => {
  it("is the CLI's path: a key, the CLI, a review", () => {
    const steps = setupSteps(facts({ hosted: false }));
    expect(steps.map((s) => s.key)).toEqual(["key", "cli", "review"]);
    expect(now(facts({ hosted: false, keys: 1, cliSignedIn: true }))).toBe("review");
  });
});
