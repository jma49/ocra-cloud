import { describe, expect, it } from "vitest";
import { github } from "../src/platforms/github.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { gitlab } from "../src/platforms/gitlab.js";
import { pullOnPlatform, pullPageUrl, repoOfIdentity } from "../src/review-pull.js";

const hub = github({ host: GITHUB_COM, id: "app", secret: "s" });
const lab = (url: string) => gitlab({ url, id: "lab", secret: "s" }, "http://ocra.test/cb");
const pull = (identity: string) => {
  const at = repoOfIdentity(identity);
  if (!at) throw new Error(`not an identity: ${identity}`);
  return { ...at, number: 3, head: "a".repeat(40) };
};

describe("the platform a reviewed pull request is on", () => {
  it("is the one on its host, with the repository's path there", () => {
    const on = pullOnPlatform(
      [hub, lab("https://gitlab.example.com")],
      pull("https://gitlab.example.com/g/p"),
    );
    expect(on?.platform.kind).toBe("gitlab");
    expect(on?.pull.repo).toBe("g/p");
    expect(on && pullPageUrl(on.platform, on.pull)).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/3",
    );
  });

  it("is found under the relative root of an instance installed under a path, and on another port", () => {
    const instance = lab("https://example.com:8443/gitlab");
    const on = pullOnPlatform([hub, instance], pull("https://example.com/gitlab/g/sub/p"));
    expect(on?.pull.repo).toBe("g/sub/p");
    expect(on && pullPageUrl(on.platform, on.pull)).toBe(
      "https://example.com:8443/gitlab/g/sub/p/-/merge_requests/3",
    );
    expect(pullOnPlatform([instance], pull("https://example.com/other/p"))).toBeUndefined();
    expect(pullOnPlatform([hub], pull("https://gitlab.example.com/g/p"))).toBeUndefined();
  });
});
