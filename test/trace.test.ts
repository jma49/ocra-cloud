import upload from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { beforeEach, describe, expect, it } from "vitest";
import { upload as counts } from "./finding-uploads.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

// A review's trace (ADR-0081 of the engine) is kept as its walkthrough is:
// only while the account shares findings, redacted on the server, read by
// its review's page, and deleted with the shared findings.

beforeEach(resetDb);

const shared = upload.trace;
// A client that skipped its own redaction pass.
const leaky = {
  ...shared,
  findings: [
    { ...shared.findings[0], reason: "Uses token ghp_abcdefghijklmnopqrstuvwxyz0123 in a test" },
  ],
};

describe("a review's trace", () => {
  it("is kept redacted only while findings are shared, and deleted with them", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    const post = async (runId: string, trace: unknown) => {
      const res = await call("/api/reviews", {
        method: "POST",
        auth: cli.auth,
        json: { ...counts(runId, []), trace },
      });
      return ((await res.json()) as { id: string }).id;
    };
    const read = (id: string) => call(`/api/reviews/${id}/trace`, { auth: web.auth });
    const sharing = (json: Record<string, boolean>) =>
      call("/api/account/sharing", {
        method: "PUT",
        auth: web.auth,
        headers: { origin: "https://ocra.test" },
        json,
      });

    expect((await read(await post("run-off", shared))).status).toBe(404);
    await sharing({ enabled: true });
    const on = await post("run-on", leaky);
    const kept = (await (await read(on)).json()) as { trace: typeof leaky & { redacted?: true } };
    expect(kept.trace.tasks).toEqual(shared.tasks);
    expect(kept.trace.redacted).toBe(true);
    expect(kept.trace.findings[0]?.reason).not.toContain("ghp_");

    await sharing({ enabled: false, deleteExisting: true });
    expect((await read(on)).status).toBe(404);
  });

  it("is read only by its own account, and a review without one answers 404", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    const other = await signIn(2, "hubot");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    const post = async (json: unknown) =>
      (
        (await (await call("/api/reviews", { method: "POST", auth: cli.auth, json })).json()) as {
          id: string;
        }
      ).id;
    const traced = await post({ ...counts("run-a", []), trace: shared });
    const bare = await post(counts("run-b", []));
    expect((await call(`/api/reviews/${traced}/trace`, { auth: other.auth })).status).toBe(404);
    expect((await call(`/api/reviews/${bare}/trace`, { auth: web.auth })).status).toBe(404);
    expect((await call(`/api/reviews/${traced}/trace`, { auth: web.auth })).status).toBe(200);
  });
});
