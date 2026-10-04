import { beforeEach, describe, expect, it } from "vitest";
import { finding, HASH, upload } from "./finding-uploads.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

beforeEach(resetDb);

describe("account memory", () => {
  it("remembers a finding once per repository, lists it for the CLI, and deletes it", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
      json: { enabled: true },
    });
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        auth: cli.auth,
        json: upload("r", [finding()]),
      })
    ).json()) as { id: string };
    const detail = (await (await call(`/api/reviews/${posted.id}`, { auth: web.auth })).json()) as {
      findings: { id: string }[];
    };
    const findingId = detail.findings[0]?.id;
    const remember = (reason: string) =>
      call("/api/memory", {
        method: "POST",
        auth: web.auth,
        headers: { origin: "https://ocra.test" },
        json: { findingId, reason },
      });
    expect((await remember("")).status).toBe(400);
    const first = (await (await remember("Accepted: internal tool")).json()) as { id: string };
    expect(await (await remember("again")).json()).toEqual({ id: first.id, duplicate: true });

    const list = (await (await call(`/api/memory?repo=${HASH}`, { auth: cli.auth })).json()) as {
      entries: { fingerprint: string; reason: string }[];
    };
    expect(list.entries).toMatchObject([
      { fingerprint: "fp-1234", reason: "Accepted: internal tool" },
    ]);
    expect(
      (await call(`/api/memory?repo=${"c".repeat(64)}`, { auth: cli.auth }).then((r) =>
        r.json(),
      )) as unknown,
    ).toEqual({ entries: [] });
    // The CLI reads memory; only the web changes it.
    expect((await call("/api/memory", { method: "POST", auth: cli.auth, json: {} })).status).toBe(
      403,
    );

    await call(`/api/memory/${first.id}`, {
      method: "DELETE",
      auth: web.auth,
      headers: { origin: "https://ocra.test" },
    });
    expect(
      ((await (await call("/api/memory", { auth: web.auth })).json()) as { entries: unknown[] })
        .entries,
    ).toEqual([]);
  });
});
