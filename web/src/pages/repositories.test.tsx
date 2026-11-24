import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api.js";
import { clearCache } from "../cache.js";
import { Repositories } from "./Repositories.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await clearCache();
});

const ME: Me = {
  login: "ada",
  githubId: 1,
  githubUrl: "https://github.com",
  avatarUrl: null,
  session: "web",
  since: "",
  codeGraphs: "off",
  autoReview: false,
  platforms: ["github", "gitlab"],
};
const HASH = "f8c2ef5b".padEnd(64, "0");
const platform = (over: object) => ({
  linked: false,
  failed: false,
  installUrl: null,
  more: false,
  repositories: [],
  ...over,
});
const repo = (over: object) => ({
  repoHash: HASH,
  repo: HASH.slice(0, 8),
  name: null,
  pulledFrom: null,
  reviews: 1,
  findings: 1,
  openFindings: 0,
  lastReviewAt: null,
  ...over,
});

function serve(platforms: unknown, repositories: unknown[], sharing = false) {
  const posted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(url);
        return Response.json({ named: 1, sharing: true });
      }
      return url === "/api/platforms/repos"
        ? Response.json({ sharing, platforms })
        : Response.json({ repositories });
    }),
  );
  return posted;
}

describe("the connected platforms", () => {
  it("offer to connect GitLab, and GitHub by signing in with it again, in place", async () => {
    serve(
      [
        platform({ platform: "github", host: "github.com" }),
        platform({ platform: "gitlab", host: "gitlab.example.com" }),
      ],
      [],
    );
    render(<Repositories me={ME} />);
    const gitlab = await screen.findByRole("link", { name: "Connect GitLab" });
    expect(gitlab.getAttribute("href")).toBe("/api/platforms/gitlab/connect");
    expect(screen.getByRole("link", { name: "Connect GitHub" }).getAttribute("href")).toBe(
      "/api/auth/github/login?next=%2Frepositories",
    );
    expect(screen.queryByText(/Sign out/)).toBeNull();
  });

  it("send a connected GitHub to choose the repositories its app reaches", async () => {
    const install = "https://github.com/apps/ocra-cloud/installations/new";
    serve(
      [platform({ platform: "github", host: "github.com", linked: true, installUrl: install })],
      [],
    );
    render(<Repositories me={ME} />);
    const choose = await screen.findByRole("link", { name: "Choose repositories" });
    expect(choose.getAttribute("href")).toBe(install);
    expect(screen.getByText(/not installed on any repository/)).toBeTruthy();
  });
});

describe("a reviewed repository", () => {
  it("shows the path its pull request reviews named, with the hash only beside it", async () => {
    serve(
      [platform({ platform: "github", host: "github.com", linked: true })],
      [repo({ pulledFrom: { host: "github.com", repo: "octo/api" } })],
    );
    render(<Repositories me={ME} />);
    expect(await screen.findByText("octo/api")).toBeTruthy();
    expect(screen.getByText(/GitHub · github.com/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename octo/api" })).toBeTruthy();
  });

  it("takes the platform's name for its hash, and stores it for every page", async () => {
    const posted = serve(
      [
        platform({
          platform: "github",
          host: "github.com",
          linked: true,
          repositories: [{ id: "1", fullName: "Octo/API", private: true, repoHash: HASH }],
        }),
      ],
      [repo({})],
      true,
    );
    render(<Repositories me={ME} />);
    expect(await screen.findByText("Octo/API")).toBeTruthy();
    await waitFor(() => expect(posted).toEqual(["/api/platforms/sync-names"]));
  });

  it("says when only its hash is known, and offers to name it", async () => {
    serve([], [repo({})]);
    render(<Repositories me={ME} />);
    expect(await screen.findByText("Unknown repository")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Name f8c2ef5b" })).toBeTruthy();
  });
});

describe("a server with no code platform", () => {
  it("says so and links to how to connect one, instead of an empty card", async () => {
    serve([], []);
    render(<Repositories me={ME} />);
    expect(await screen.findByText("No code platform on this server")).toBeTruthy();
    expect(screen.getByRole("link", { name: "How to connect one" }).getAttribute("href")).toMatch(
      /self-hosting\.md#a-github-app-of-your-own$/,
    );
  });
});

describe("the repositories list's keys", () => {
  it("move a current row and open its name for editing", async () => {
    serve(
      [],
      [
        repo({ name: "octo/api" }),
        repo({ repoHash: "b".repeat(64), repo: "bbbbbbbb", name: "octo/web" }),
      ],
    );
    render(<Repositories me={ME} />);
    const first = (await screen.findByText("octo/api")).closest("tr") as HTMLElement;
    expect(first.className).not.toContain("is-current");

    fireEvent.keyDown(document.body, { key: "j" });
    expect(first.className).toContain("is-current");
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "e" });
    expect(screen.getByRole("textbox", { name: "Name of octo/web" })).toHaveProperty(
      "value",
      "octo/web",
    );
    expect(screen.queryByRole("textbox", { name: "Name of octo/api" })).toBeNull();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of octo/web" }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename octo/web" })).toBeTruthy();
  });
});
