import { beforeEach, describe, expect, it } from "vitest";
import memory from "../src/contract/fixtures/memory.json";
import preferences from "../src/contract/fixtures/preferences.json";
import upload from "../src/contract/fixtures/upload.json";
import { memoryEntrySchema, PROVIDER_IDS } from "../src/contract/index.js";
import { providers } from "../src/providers.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

// The engine's contract fixtures (#25), copied with the contract
// (scripts/sync-contract.mjs) at the commit contract.lock pins. The engine
// makes upload.json from the CLI's real upload; a change of shape there
// reaches this test with the next sync.

beforeEach(resetDb);
const json = { "content-type": "application/json" };
const origin = { origin: "https://ocra.test" };
const { about: _, ...body } = upload;

async function shareFindings(web: { auth: Record<string, string> }) {
  const res = await call("/api/account/sharing", {
    method: "PUT",
    headers: { ...web.auth, ...json, ...origin },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(200);
}

describe("the CLI's real upload", () => {
  it("keeps every count and every field of every finding", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    await shareFindings(web);
    const res = await call("/api/reviews", {
      method: "POST",
      headers: { ...cli.auth, ...json },
      body: JSON.stringify(body),
    });
    const answer = (await res.json()) as Record<string, unknown>;
    expect(answer).toEqual({ id: expect.any(String), findings: body.findingList.length });

    const detail = (await (
      await call(`/api/reviews/${answer.id}`, { headers: web.auth })
    ).json()) as { review: Record<string, unknown>; findings: Record<string, unknown>[] };
    const { critical, warning, suggestion } = body.findings;
    expect(detail.review).toMatchObject({
      runId: body.runId,
      repoHash: body.repoHash,
      source: body.source,
      tier: body.tier,
      verdict: body.verdict,
      complete: body.complete,
      findings: critical + warning + suggestion,
      critical,
      warning,
      suggestion,
      filesReviewed: body.files.reviewed,
      filesNotReviewed: body.files.notReviewed,
      tasksCompleted: body.tasks.completed,
      tasksFailed: body.tasks.failed,
      tokensIn: body.usage.inputTokens,
      tokensOut: body.usage.outputTokens,
      costUsd: body.usage.costUsd,
      durationMs: body.durationMs,
      ocraVersion: body.ocraVersion,
      byReviewer: body.reviewers,
      verification: body.verification,
      fixed: body.outcomes.fixed,
      dismissed: body.outcomes.dismissed,
    });
    const stored = detail.findings.map(({ id: _id, createdAt: _at, ...f }) => f);
    expect(stored).toEqual(
      body.findingList.map((f) => ({ redacted: false, truncated: false, ...f })),
    );
  });
});

describe("the account's preferences", () => {
  it("save the fixture's parts and answer them back unchanged, as the CLI reads them", async () => {
    const web = await signIn(1, "octo");
    const cli = await signInCli(1, "octo");
    const { updatedAt: _u, version: _v, ...parts } = preferences.answer;
    const put = await call("/api/preferences", {
      method: "PUT",
      headers: { ...web.auth, ...json, ...origin },
      body: JSON.stringify(parts),
    });
    expect(put.status).toBe(200);
    const got = (await (await call("/api/preferences", { headers: cli.auth })).json()) as Record<
      string,
      unknown
    >;
    expect(got).toEqual({ ...parts, updatedAt: expect.any(String), version: expect.any(String) });
  });
});

describe("the account's memory", () => {
  it("is listed in the fixture's shape", async () => {
    const cli = await signInCli(1, "octo");
    const web = await signIn(1, "octo");
    await shareFindings(web);
    const posted = (await (
      await call("/api/reviews", {
        method: "POST",
        headers: { ...cli.auth, ...json },
        body: JSON.stringify(body),
      })
    ).json()) as { id: string };
    const detail = (await (
      await call(`/api/reviews/${posted.id}`, { headers: web.auth })
    ).json()) as { findings: { id: string }[] };
    await call("/api/memory", {
      method: "POST",
      headers: { ...web.auth, ...json, ...origin },
      body: JSON.stringify({ findingId: detail.findings[0]?.id, reason: "Accepted." }),
    });
    const list = (await (
      await call(`/api/memory?repo=${body.repoHash}`, { headers: cli.auth })
    ).json()) as { entries: unknown[] };
    const [served] = list.entries;
    const [sample] = memory.answer.entries;
    expect(memoryEntrySchema.parse(served)).toEqual(served);
    expect(Object.keys(served as object).sort()).toEqual(Object.keys(sample ?? {}).sort());
  });
});

describe("the gateway's providers", () => {
  it("are the contract's provider ids, no more and no fewer", () => {
    expect(Object.keys(providers).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});
