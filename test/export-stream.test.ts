import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import app from "../src/index.js";
import { db, request, resetDb, signIn } from "./helpers.js";
import { metered } from "./metered.js";

// Audit C9: the export reads a page of rows only as the client takes the
// last one, so a slow reader cannot make the Worker queue every table.

beforeEach(resetDb);

const EVENTS = 2000;

describe("the export", () => {
  it("reads no further ahead than the client has read, and still holds every row", async () => {
    const me = await signIn(1, "octo");
    const d = scoped(db, me.account.id);
    for (let start = 0; start < EVENTS; start += 500) {
      await d.batch((w) =>
        Array.from({ length: 500 }, (_, i) =>
          w.insert("auditEvents", { kind: "key.used", detail: { n: start + i } }),
        ),
      );
    }
    const { DB, meter } = metered();
    const ctx = createExecutionContext();
    const res = await app.fetch(request("/api/export", { auth: me.auth }), { ...env, DB }, ctx);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks = [(await reader.read()).value];
    // Time enough for a reader that ran ahead to have read every event.
    for (let i = 0; i < 20; i++) await scheduler.wait(10);
    expect(meter.read).toBeLessThan(EVENTS / 2);

    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(next.value);
    }
    await waitOnExecutionContext(ctx);
    const text = new TextDecoder().decode(
      new Uint8Array(chunks.flatMap((c) => Array.from(c ?? []))),
    );
    const body = JSON.parse(text) as { auditEvents: { detail: { n: number } }[] };
    expect(body.auditEvents.map((e) => e.detail.n).sort((a, b) => a - b)).toEqual(
      Array.from({ length: EVENTS }, (_, i) => i),
    );
  });
});
