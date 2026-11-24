import { describe, expect, it } from "vitest";
import { runRunner } from "../src/node/remote-runner.js";
import { fakeExec, fixLoop, RUNNER_TOKEN, round } from "./fix-loop-fakes.js";
import { ORIGIN } from "./graph-server.js";

// A round of the fix loop as a remote runner takes it (docs/runner.md): the
// runner reads the claim with its own schema before anything runs.

const t = fixLoop();
const { setLevel, loop, data } = t;
const hello = { name: "mini", version: "0.22.0" };

describe("a remote runner", () => {
  it("takes a round that brings no findings, as one over conflicts alone does", async () => {
    await setLevel("commit", t.auth, false, true);
    await t.s.call("/api/auto-review/mends/conflicts", {
      method: "POST",
      headers: t.auth,
      json: { platform: "github", repo: "Octo/API", number: 7 },
    });
    await data().update("mendJobs", (await loop())?.id ?? "", { notBefore: null });
    const stop = new AbortController();
    const { exec, seen } = fakeExec(JSON.stringify(round({ items: [] })));
    let settled = false;
    await runRunner(
      {
        server: ORIGIN,
        token: RUNNER_TOKEN,
        ...hello,
        exec,
        cli: "/opt/ocra/main.js",
        pollMs: 5,
        fetch: async (input, init) => {
          const res = await t.s.host.fetch(new Request(input, init));
          // The runner asks again after its report, or after a claim it could not read.
          if (settled || String(input).endsWith("/claim")) stop.abort();
          if (String(input).endsWith("/settle-answer")) settled = true;
          return res;
        },
      },
      stop.signal,
    );
    expect(seen.args.slice(9)).toEqual(["--conflicts", "--config", expect.any(String)]);
    expect(await loop()).toMatchObject({ state: "done", outcome: "committed" });
  });
});
