import { beforeEach, describe, expect, it } from "vitest";
import type { PullView } from "../src/shared/index.js";
import { call, ORIGIN, resetDb, signIn } from "./helpers.js";

beforeEach(resetDb);

async function account(id = 1, login = "octo") {
  const web = await signIn(id, login);
  const send = (method: string, path: string, json?: unknown) =>
    call(path, {
      method,
      auth: web.auth,
      headers: { origin: ORIGIN },
      ...(json === undefined ? {} : { json }),
    });
  const views = async () =>
    ((await (await send("GET", "/api/pull-views")).json()) as { views: PullView[] }).views;
  return { send, views };
}

const failing = { name: "Failing CI", filters: { roles: ["author"], checks: ["failing"] } };

describe("pull request views", () => {
  it("are added after the last, changed and removed by their owner", async () => {
    const a = await account();
    const first = await a.send("POST", "/api/pull-views", failing);
    expect(first.status).toBe(201);
    const second = (await (
      await a.send("POST", "/api/pull-views", {
        name: "Web",
        filters: { repos: ["github.com/octo/web"] },
      })
    ).json()) as PullView;
    expect((await a.views()).map((v) => [v.name, v.position])).toEqual([
      ["Failing CI", 0],
      ["Web", 1],
    ]);

    await a.send("PUT", `/api/pull-views/${second.id}`, { name: "Web app", position: 0 });
    expect((await a.views()).map((v) => v.name)).toEqual(["Failing CI", "Web app"]);
    expect((await a.views())[1]?.filters).toEqual({ repos: ["github.com/octo/web"] });

    expect((await a.send("DELETE", `/api/pull-views/${second.id}`)).status).toBe(200);
    expect((await a.views()).map((v) => v.name)).toEqual(["Failing CI"]);
    expect((await a.send("DELETE", `/api/pull-views/${second.id}`)).status).toBe(404);
  });

  it("refuse unknown filters, control characters and a twenty-first view", async () => {
    const a = await account();
    for (const body of [
      { name: "x", filters: { colour: ["red"] } },
      { name: "x", filters: { checks: ["green"] } },
      { name: "a\u0007b", filters: {} },
      { name: "", filters: {} },
    ]) {
      expect((await a.send("POST", "/api/pull-views", body)).status).toBe(400);
    }
    const adds = await Promise.all(
      Array.from({ length: 22 }, (_, i) =>
        a.send("POST", "/api/pull-views", { name: `v${i}`, filters: {} }),
      ),
    );
    expect(adds.filter((r) => r.status === 201)).toHaveLength(20);
    expect(await a.views()).toHaveLength(20);
  });

  it("belong to one account", async () => {
    const a = await account(1, "octo");
    const b = await account(2, "other");
    const view = (await (await a.send("POST", "/api/pull-views", failing)).json()) as PullView;
    expect(await b.views()).toEqual([]);
    expect((await b.send("PUT", `/api/pull-views/${view.id}`, { name: "mine" })).status).toBe(404);
    expect((await b.send("DELETE", `/api/pull-views/${view.id}`)).status).toBe(404);
    expect((await a.views())[0]?.name).toBe("Failing CI");
  });
});
