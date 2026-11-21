/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from "vitest";
import { call, JSON_TYPE, resetDb, signIn } from "./helpers.js";

// One boundary layer (#31): bodies are read only by src/http.ts's jsonBody
// (with src/body.ts's streamed limit) and checked by a schema; the gateway
// alone reads its body as text, to forward it unchanged.
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

beforeEach(resetDb);

describe("the API boundary", () => {
  it("reads no body outside it", () => {
    const readers = Object.entries(sources)
      .filter(([file]) => !file.endsWith("/body.ts"))
      .flatMap(([file, text]) =>
        [
          ...text.matchAll(/c\.req\.(json|text|parseBody|arrayBuffer)\(|readJson\(|readText\(/g),
        ].map((m) => `${file.replace("../src/", "")}: ${m[0]}`),
      );
    expect(readers).toEqual(["gateway.ts: readText(", "http.ts: readJson(", "http.ts: readText("]);
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("reads rows with queries, never by filtering a whole table (#34)", () => {
    const wholeTables = Object.entries(sources)
      .filter(([file]) => !file.includes("/db/"))
      .flatMap(([file, text]) =>
        [...text.matchAll(/\.list\("(\w+)"\)/g)].map(
          (m) => `${file.replace("../src/", "")}: ${m[1]}`,
        ),
      );
    // The keys page shows every key the account holds.
    expect(wholeTables).toEqual(["keys.ts: providerKeys"]);
  });

  it("answers a body that does not fit with invalid_body and where", async () => {
    const web = await signIn(1, "octo");
    const res = await call("/api/preferences", {
      method: "PUT",
      auth: web.auth,
      json: {
        settings: { concurrency: 64 },
        models: { top: ["ocra-anthropic/claude"] },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: unknown[] }[] };
    expect(body.error).toBe("invalid_body");
    expect(body.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([["settings", "concurrency"]]),
    );
  });

  it("answers a body that is not JSON as one that does not fit", async () => {
    const web = await signIn(1, "octo");
    const res = await call("/api/account/sharing", {
      method: "PUT",
      auth: web.auth,
      headers: JSON_TYPE,
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });
});
