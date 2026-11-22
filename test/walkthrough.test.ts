import { beforeEach, describe, expect, it } from "vitest";
import { upload } from "./finding-uploads.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

// A review's walkthrough is kept as its findings are: only while the account
// shares them, redacted on the server, shown with the review, and deleted
// with the shared findings.

beforeEach(resetDb);

const walkthrough = {
  overview: "Adds a retry with token ghp_abcdefghijklmnopqrstuvwxyz0123 to the client",
  groups: [{ title: "Client", files: ["src/client.ts"], note: "Retries on 503" }],
  diagram: "sequenceDiagram\n  A->>B: call",
};

type Detail = { walkthrough: Record<string, unknown> | null };

describe("a review's walkthrough", () => {
  it("is kept redacted only while findings are shared, and deleted with them", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    const post = async (runId: string) => {
      const res = await call("/api/reviews", {
        method: "POST",
        auth: cli.auth,
        json: { ...upload(runId, []), walkthrough },
      });
      return ((await res.json()) as { id: string }).id;
    };
    const detail = async (id: string) =>
      (await (await call(`/api/reviews/${id}`, { auth: web.auth })).json()) as Detail;
    const sharing = (json: Record<string, boolean>) =>
      call("/api/account/sharing", {
        method: "PUT",
        auth: web.auth,
        headers: { origin: "https://ocra.test" },
        json,
      });

    expect((await detail(await post("run-off"))).walkthrough).toBeNull();
    await sharing({ enabled: true });
    const on = await post("run-on");
    const shown = (await detail(on)).walkthrough;
    expect(shown).toMatchObject({
      groups: walkthrough.groups,
      diagram: walkthrough.diagram,
      redacted: true,
      truncated: false,
    });
    expect(String(shown?.overview)).not.toContain("ghp_");
    const exported = await call(`/api/reviews/${on}/export`, { auth: web.auth });
    expect(await exported.json()).toMatchObject({ walkthrough: { groups: walkthrough.groups } });

    await sharing({ enabled: false, deleteExisting: true });
    expect((await detail(on)).walkthrough).toBeNull();
  });
});
