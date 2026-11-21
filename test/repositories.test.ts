import { beforeEach, describe, expect, it } from "vitest";
import { finding, HASH, upload } from "./finding-uploads.js";
import { call, ORIGIN, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);

type Repo = {
  repoHash: string;
  name: string | null;
  reviews: number;
  openFindings: number;
};

async function account(id = 1, login = "octo") {
  const web = await signIn(id, login);
  const cli = await signInCli(id, login);
  const send = (method: string, path: string, json?: unknown) =>
    call(path, {
      method,
      auth: web.auth,
      headers: { origin: ORIGIN },
      ...(json === undefined ? {} : { json }),
    });
  const repos = async () =>
    (
      (await (await call("/api/repositories", { auth: web.auth })).json()) as {
        repositories: Repo[];
      }
    ).repositories;
  return { web, cli, send, repos };
}

describe("repositories", () => {
  it("lists the hashes reviews came from, and shows the name the account gives one", async () => {
    const a = await account();
    await a.send("PUT", "/api/account/sharing", { enabled: true });
    await call("/api/reviews", {
      method: "POST",
      auth: a.cli.auth,
      json: upload("r1", [finding({ fingerprint: "fp-1" }), finding({ fingerprint: "fp-2" })]),
    });
    expect(await a.repos()).toMatchObject([
      { repoHash: HASH, name: null, reviews: 1, openFindings: 2 },
    ]);

    expect((await a.send("PUT", `/api/repositories/${HASH}`, { name: " " })).status).toBe(400);
    expect((await a.send("PUT", "/api/repositories/not-a-hash", { name: "x" })).status).toBe(404);
    expect((await a.send("PUT", `/api/repositories/${HASH}`, { name: "octo/api" })).status).toBe(
      200,
    );
    await a.send("PUT", `/api/repositories/${HASH}`, { name: "octo/api-v2" });
    expect(await a.repos()).toMatchObject([{ repoHash: HASH, name: "octo/api-v2" }]);

    const inbox = (await (await call("/api/findings", { auth: a.web.auth })).json()) as {
      findings: { name: string | null }[];
    };
    expect(inbox.findings.map((f) => f.name)).toEqual(["octo/api-v2", "octo/api-v2"]);
    const listed = (await (await call("/api/reviews", { auth: a.web.auth })).json()) as {
      reviews: { name: string | null }[];
    };
    expect(listed.reviews.map((r) => r.name)).toEqual(["octo/api-v2"]);

    const other = await account(2, "other");
    expect(await other.repos()).toEqual([]);

    await a.send("DELETE", `/api/repositories/${HASH}`);
    expect(await a.repos()).toMatchObject([{ repoHash: HASH, name: null }]);
  });

  it("keeps a named repository with no reviews in the list", async () => {
    const a = await account();
    const hash = "d".repeat(64);
    await a.send("PUT", `/api/repositories/${hash}`, { name: "octo/quiet" });
    expect(await a.repos()).toEqual([
      expect.objectContaining({ repoHash: hash, name: "octo/quiet", reviews: 0 }),
    ]);
  });
});
