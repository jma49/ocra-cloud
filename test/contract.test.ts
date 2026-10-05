import { memoryEntrySchema, PROVIDER_IDS } from "@open-cr-agent/cloud-contract";
import memory from "@open-cr-agent/cloud-contract/fixtures/memory.json";
import preferences from "@open-cr-agent/cloud-contract/fixtures/preferences.json";
import upload from "@open-cr-agent/cloud-contract/fixtures/upload.json";
import { beforeEach, describe, expect, it } from "vitest";
import { providers } from "../src/providers.js";
import { call, resetDb, signIn, signInCli } from "./helpers.js";

// The engine's contract fixtures (#25), shipped in @open-cr-agent/cloud-contract
// at the version package.json pins. The engine makes upload.json from the
// CLI's real upload; a change of shape there reaches this test with the next
// version bump.

beforeEach(resetDb);
const origin = { origin: "https://ocra.test" };
const { about: _, ...body } = upload;

async function shareFindings(web: { auth: Record<string, string> }) {
  const res = await call("/api/account/sharing", {
    method: "PUT",
    auth: web.auth,
    headers: origin,
    json: { enabled: true },
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
      auth: cli.auth,
      json: body,
    });
    const answer = (await res.json()) as Record<string, unknown>;
    expect(answer).toEqual({ id: expect.any(String), findings: body.findingList.length });

    const detail = (await (await call(`/api/reviews/${answer.id}`, { auth: web.auth })).json()) as {
      review: Record<string, unknown>;
      findings: Record<string, unknown>[];
    };
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
      auth: web.auth,
      headers: origin,
      json: parts,
    });
    expect(put.status).toBe(200);
    const got = (await (await call("/api/preferences", { auth: cli.auth })).json()) as Record<
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
        auth: cli.auth,
        json: body,
      })
    ).json()) as { id: string };
    const detail = (await (await call(`/api/reviews/${posted.id}`, { auth: web.auth })).json()) as {
      findings: { id: string }[];
    };
    await call("/api/memory", {
      method: "POST",
      auth: web.auth,
      headers: origin,
      json: { findingId: detail.findings[0]?.id, reason: "Accepted." },
    });
    const list = (await (
      await call(`/api/memory?repo=${body.repoHash}`, { auth: cli.auth })
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
