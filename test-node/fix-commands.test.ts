import { describe, expect, it, vi } from "vitest";
import { hmacHex } from "../src/crypto.js";
import { GITHUB_COM } from "../src/platforms/github-host.js";
import { fakeExec, fixLoop, round } from "./fix-loop-fakes.js";
import { C1 } from "./graph-fakes.js";
import { SECRET } from "./graph-server.js";

// `@ocra fix` and `@ocra stop`: the pull request's fix loop asked for and
// stopped from a comment, with a label on the pull request while it works.

const t = fixLoop();
const { setLevel, loop, items } = t;

const GH = `${GITHUB_COM.api}/repos/Octo/API`;
const LABEL = "ocra: fixing";

type Sent = { method: string; url: string; body: unknown };
let sent: Sent[] = [];
let labels: string[] = [];
const said = () =>
  sent
    .filter((w) => w.url === `${GH}/issues/7/comments`)
    .map((w) => (w.body as { body: string }).body);
const labelWrites = () => sent.filter((w) => w.url.includes("/labels"));

/** The platform as the bot reaches it, with the review uploaded as the CLI names the repository. */
async function platform() {
  for (const r of await t.data().list("reviews")) {
    await t.data().update("reviews", r.id, { prRepository: "https://github.com/octo/api" });
  }
  sent = [];
  labels = [];
  const passed = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = req.url;
    if (!url.startsWith(GITHUB_COM.api)) return passed(input, init);
    if (req.method !== "GET") {
      const text = await req.text();
      sent.push({ method: req.method, url, body: text ? JSON.parse(text) : null });
      if (url === `${GH}/issues/7/labels`) labels.push(LABEL);
      if (req.method === "DELETE") labels = [];
      return Response.json({ id: 1 }, { status: 201 });
    }
    if (url.endsWith("/collaborators/alice/permission"))
      return Response.json({ permission: "write" });
    if (url === `${GH}/pulls/7`) {
      return Response.json({
        title: "t",
        body: "",
        head: { sha: C1 },
        changed_files: 1,
        additions: 1,
        deletions: 0,
      });
    }
    if (url.startsWith(`${GH}/issues/7/labels`))
      return Response.json(labels.map((name) => ({ name })));
    return new Response(null, { status: 404 });
  });
}

let ids = 900;
async function comment(body: string) {
  const json = JSON.stringify({
    action: "created",
    comment: { id: ids++, body, user: { type: "User", login: "alice" } },
    issue: { number: 7, pull_request: { url: "x" } },
    repository: { id: 11, full_name: "Octo/API" },
  });
  await t.s.call("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-hub-signature-256": `sha256=${await hmacHex(SECRET, json)}`,
    },
    body: json,
  });
  await t.s.host.idle();
}

describe("fixing from a comment", () => {
  it("asks the loop for the head's open findings and labels the pull request", async () => {
    await setLevel("commit");
    await platform();
    await comment("@ocra fix");
    const asked = await items();
    expect(Object.keys(asked).sort()).toEqual(["fp-crit", "fp-warn"]);
    expect(Object.values(asked).map((i) => i.outcome)).toEqual([null, null]);
    expect(await loop()).toMatchObject({ state: "queued", labeled: true });
    expect(labelWrites()).toEqual([
      { method: "POST", url: `${GH}/issues/7/labels`, body: { labels: [LABEL] } },
    ]);
    expect(said()).toEqual([
      expect.stringMatching(/^Fixing 2 open findings on `1111111`: .*`@ocra stop` stops it\.$/),
    ]);
    await comment("@ocra fix");
    expect(said()[1]).toBe("Fixes for the open findings on `1111111` were asked for already.");
  });

  it("takes the label off once the last round has ended", async () => {
    await setLevel("commit");
    await platform();
    await comment("@ocra fix");
    sent = [];
    await t.runRound(fakeExec(JSON.stringify(round())).exec);
    expect(await loop()).toMatchObject({ state: "done", labeled: false });
    expect(labelWrites()).toEqual([
      { method: "DELETE", url: `${GH}/issues/7/labels/ocra%3A%20fixing`, body: null },
    ]);
  });

  it("stops a loop whose round waits, putting its findings off", async () => {
    await setLevel("commit");
    await platform();
    await comment("@ocra fix");
    await comment("@ocra stop");
    expect(await loop()).toMatchObject({ state: "done", error: "stopped", labeled: false });
    expect(Object.values(await items()).map((i) => i.outcome)).toEqual(["deferred", "deferred"]);
    expect(labelWrites().map((w) => w.method)).toEqual(["POST", "DELETE"]);
    expect(said()[1]).toMatch(/^Stopped: /);
    await comment("@ocra stop");
    expect(said()[2]).toBe("ocra is not fixing this pull request.");
    // Asked again, the put-off findings wait for a round once more.
    await comment("@ocra fix");
    expect(await loop()).toMatchObject({ state: "queued", stop: false });
  });

  it("lets a round under way finish, and runs none after it", async () => {
    await setLevel("commit");
    await platform();
    await comment("@ocra fix");
    const { exec } = fakeExec(
      JSON.stringify(round({ outcome: "committed", items: [{ ...round().items[0] }] })),
      0,
      () => comment("@ocra stop"),
    );
    await t.runRound(exec);
    expect(said()[1]).toMatch(/^Stopping: /);
    // The finding the round put off kept the loop queued: the next claim ends it.
    expect(await loop()).toMatchObject({ state: "queued", stop: true });
    await t.runRound(fakeExec("").exec);
    expect(await loop()).toMatchObject({ state: "done", error: "stopped", labeled: false });
    expect((await items())["fp-warn"]?.outcome).toBe("deferred");
    expect(labelWrites().map((w) => w.method)).toEqual(["POST", "DELETE"]);
  });

  it("says so where the repository does not let ocra commit", async () => {
    await platform();
    await comment("@ocra fix");
    expect(await loop()).toBeUndefined();
    expect(labelWrites()).toEqual([]);
    expect(said()).toEqual([
      expect.stringMatching(/^ocra does not commit fixes to this repository/),
    ]);
  });
});
