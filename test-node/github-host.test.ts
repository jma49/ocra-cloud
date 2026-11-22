import { describe, expect, it } from "vitest";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { githubHostOf } from "../src/platforms/registry.js";

describe("the deployment's GitHub", () => {
  it("is github.com, with its own API host, when GITHUB_URL is unset or names it", () => {
    expect(githubHostOf({})).toBe(GITHUB_COM);
    expect(githubHostOf({ GITHUB_URL: "https://github.com/" })).toBe(GITHUB_COM);
  });

  it("is a GitHub Enterprise Server's REST, GraphQL and web addresses on one host and port", () => {
    expect(githubHostOf({ GITHUB_URL: "https://github.example.com:8443/" })).toEqual({
      host: "github.example.com:8443",
      url: "https://github.example.com:8443",
      api: "https://github.example.com:8443/api/v3",
      graphql: "https://github.example.com:8443/api/graphql",
      avatars: null,
    });
  });
});
