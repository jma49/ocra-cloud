import { describe, expect, it } from "vitest";
import { allowEntriesOf } from "../src/sign-in-allow.js";

// SIGN_IN_ALLOW's entries, read as test/sign-in-allow.test.ts uses them.

describe("the list's entries", () => {
  it("are normalised: lowercased logins and domains, a domain's ASCII form", () => {
    expect(
      allowEntriesOf(" org:Acme ,USER:Ada,domain:Bücher.Example.,group:Company/Eng ,"),
    ).toEqual({
      orgs: ["acme"],
      users: ["ada"],
      domains: ["xn--bcher-kva.example"],
      groups: ["Company/Eng"],
    });
    expect(allowEntriesOf("  ")).toBeUndefined();
  });

  it("refuse what is no plain entry", () => {
    for (const bad of [
      "acme",
      "org:",
      "org:a/b",
      "domain:a.com:443",
      "domain:ada@a.com",
      "domain:1.2.3.4",
    ]) {
      expect(() => allowEntriesOf(bad), bad).toThrow(/SIGN_IN_ALLOW/);
    }
  });
});
