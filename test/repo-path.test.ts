import { beforeEach, expect, it } from "vitest";
import { call, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);

it("accepts repository references on either platform up to 255 characters", async () => {
  const { auth } = await signIn(1, "octo");
  for (const [platform, repo] of [
    ["github", "Octo/API.v2"],
    ["gitlab", "Group/Sub-1/my_project"],
    ["gitlab", `g/${"p".repeat(253)}`],
  ]) {
    const res = await call("/api/pulls/seen", {
      method: "POST",
      auth,
      json: { platform, repo, number: 1, updatedAt: "2026-01-01T00:00:00Z", head: null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: 1 });
  }
});

it("reports bad repository paths in bodies but answers not_found for queries", async () => {
  const { auth } = await signIn(1, "octo");
  for (const [repo, message] of [
    ["group//project", "not a repository path"],
    ["group/./project", "not a repository path"],
    ["group/../project", "not a repository path"],
    ["group/project?", "not a repository path"],
    [`g/${"p".repeat(254)}`, "Too big: expected string to have <=255 characters"],
  ] as const) {
    const res = await call("/api/pulls/comment", {
      method: "POST",
      auth,
      json: { platform: "github", repo, number: 1, body: "Thanks" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_body",
      issues: [{ path: ["repo"], message }],
    });

    for (const path of ["pulls/files", "pulls/checks", "insights/cycle"]) {
      const query = new URLSearchParams({ platform: "github", repo, number: "1" });
      const read = await call(`/api/${path}?${query}`, { auth });
      expect(read.status).toBe(404);
      expect(await read.json()).toEqual({ error: "not_found" });
    }
  }
});
