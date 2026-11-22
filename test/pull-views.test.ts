import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PULL_VIEWS, type PullView, type PullViewsAnswer } from "../src/shared/index.js";
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
  const answer = async () =>
    (await (await send("GET", "/api/pull-views")).json()) as PullViewsAnswer;
  const views = async () => (await answer()).views;
  const add = async (name: string, filters: unknown = {}) =>
    (await (await send("POST", "/api/pull-views", { name, filters })).json()) as PullView;
  return { send, views, answer, add };
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

  it("keep one name once per account, on adding and on renaming", async () => {
    const a = await account();
    const b = await account(2, "other");
    await a.add("Mine");
    const other = await a.add("Other");
    const again = await a.send("POST", "/api/pull-views", { name: "Mine", filters: {} });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ issues: [{ path: ["name"] }] });
    const rename = await a.send("PUT", `/api/pull-views/${other.id}`, { name: "Mine" });
    expect(rename.status).toBe(400);
    expect((await a.views()).map((v) => v.name)).toEqual(["Mine", "Other"]);
    expect((await a.send("PUT", `/api/pull-views/${other.id}`, { name: "Other" })).status).toBe(
      200,
    );
    expect((await b.send("POST", "/api/pull-views", { name: "Mine", filters: {} })).status).toBe(
      201,
    );
  });

  it("hide, and take the newer filters, labels, verdicts and days within bounds", async () => {
    const a = await account();
    const view = await a.add("Blocked", {
      authoredBy: "others",
      verdicts: ["blocking", "unreviewed"],
      labels: ["security"],
      reviews: ["none"],
      updatedWithinDays: 14,
    });
    expect(view).toMatchObject({ hidden: false, filters: { updatedWithinDays: 14 } });
    const hidden = (await (
      await a.send("PUT", `/api/pull-views/${view.id}`, { hidden: true })
    ).json()) as PullView;
    expect(hidden).toMatchObject({ hidden: true, name: "Blocked" });
    for (const filters of [
      { updatedWithinDays: 0 },
      { updatedWithinDays: 366 },
      { verdicts: ["maybe"] },
      { authoredBy: "anyone" },
      { labels: Array.from({ length: 51 }, (_, i) => `l${i}`) },
      { labels: ["x".repeat(101)] },
    ]) {
      expect((await a.send("POST", "/api/pull-views", { name: "x", filters })).status).toBe(400);
    }
  });

  it("are put in a new order only when it names each of the account's views once", async () => {
    const a = await account();
    const b = await account(2, "other");
    const [x, y, z] = [await a.add("x"), await a.add("y"), await a.add("z")];
    const theirs = await b.add("theirs");
    for (const ids of [
      [x.id, y.id],
      [x.id, y.id, y.id],
      [x.id, y.id, theirs.id],
      [x.id, y.id, z.id, theirs.id],
    ]) {
      expect((await a.send("PUT", "/api/pull-views/order", { ids })).status).toBe(400);
    }
    const ordered = await a.send("PUT", "/api/pull-views/order", { ids: [z.id, x.id, y.id] });
    expect(ordered.status).toBe(200);
    expect((await a.views()).map((v) => [v.name, v.position])).toEqual([
      ["z", 0],
      ["x", 1],
      ["y", 2],
    ]);
    expect((await b.views()).map((v) => [v.name, v.position])).toEqual([["theirs", 0]]);
  });

  it("offer the defaults while the account has none, and keep them once asked", async () => {
    const a = await account();
    const b = await account(2, "other");
    expect(await a.answer()).toEqual({ views: [], defaults: DEFAULT_PULL_VIEWS });
    const kept = await Promise.all([
      a.send("POST", "/api/pull-views/defaults"),
      a.send("POST", "/api/pull-views/defaults"),
    ]);
    expect(kept.map((r) => r.status)).toEqual([200, 200]);
    const views = await a.views();
    expect(views.map((v) => [v.name, v.position])).toEqual(
      DEFAULT_PULL_VIEWS.map((d, i) => [d.name, i]),
    );
    expect(views[0]?.filters).toEqual(DEFAULT_PULL_VIEWS[0]?.filters);
    expect((await a.answer()).defaults).toEqual([]);
    expect(await b.views()).toEqual([]);

    const own = await b.add("Own");
    await b.send("POST", "/api/pull-views/defaults");
    expect((await b.views()).map((v) => v.id)).toEqual([own.id]);
  });
});
