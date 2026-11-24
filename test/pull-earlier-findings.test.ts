import { beforeEach, describe, expect, it } from "vitest";
import type { Row } from "../src/db/scoped.js";
import type { FileRead } from "../src/platforms/files.js";
import { earlierOpen, outdatedOf } from "../src/pull-earlier-findings.js";
import { HEAD, seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// Open findings of a pull request's earlier heads, listed apart on its page
// and marked outdated only once the lines they are about changed.

beforeEach(resetDb);

const NOW = "c".repeat(40);
const THEN = "d".repeat(40);

const review = (id: string, head: string) => ({ id, prHeadSha: head }) as Row<"reviews">;
const finding = (over: Partial<Row<"findings">>) =>
  ({
    id: "f",
    fingerprint: "fp",
    status: "open",
    file: "src/a.ts",
    lineStart: 2,
    lineEnd: 3,
    ...over,
  }) as Row<"findings">;

describe("which findings are earlier", () => {
  it("lists an earlier head's open findings no review of the head shown holds", () => {
    const listed = earlierOpen(
      [
        { review: review("r3", NOW), findings: [finding({ id: "a", fingerprint: "same" })] },
        {
          review: review("r2", THEN),
          findings: [
            finding({ id: "b", fingerprint: "same" }),
            finding({ id: "c", fingerprint: "kept" }),
            finding({ id: "d", fingerprint: "done", status: "fixed" }),
          ],
        },
        {
          review: review("r1", "e".repeat(40)),
          findings: [
            finding({ id: "e", fingerprint: "kept" }),
            finding({ id: "f", fingerprint: "done" }),
          ],
        },
      ],
      NOW,
    );
    expect(listed.map((e) => [e.finding.id, e.head])).toEqual([["c", THEN]]);
  });
});

const text = (...lines: string[]) => new TextEncoder().encode(`${lines.join("\n")}\n`);
const file = (blobId: string | null, bytes?: Uint8Array): FileRead => ({
  path: "src/a.ts",
  blobId,
  bytes,
  lastCommit: null,
});

describe("whether an earlier finding is outdated", () => {
  const earlier = (over: Partial<Row<"findings">> = {}) => [{ finding: finding(over), head: THEN }];
  const at = (then: FileRead, now: FileRead | null) => async (commit: string) =>
    commit === THEN ? [then] : now && [now];

  it("is not while its lines read the same, even when the file changed elsewhere", async () => {
    const then = file("1", text("a", "b", "c", "d"));
    expect(await outdatedOf(earlier(), NOW, at(then, file("1", text("a"))))).toEqual([false]);
    const now = file("2", text("a", "b", "c", "changed"));
    expect(await outdatedOf(earlier(), NOW, at(then, now))).toEqual([false]);
  });

  it("is once its lines changed, or its file is gone", async () => {
    const then = file("1", text("a", "b", "c", "d"));
    const now = file("2", text("a", "b", "x", "d"));
    expect(await outdatedOf(earlier(), NOW, at(then, now))).toEqual([true]);
    expect(await outdatedOf(earlier(), NOW, at(then, file(null)))).toEqual([true]);
    const whole = earlier({ lineStart: null, lineEnd: null });
    expect(await outdatedOf(whole, NOW, at(then, now))).toEqual([true]);
  });

  it("is not when a file could not be read: nothing is marked on a guess", async () => {
    const then = file("1", text("a", "b", "c", "d"));
    expect(await outdatedOf(earlier(), NOW, at(then, null))).toEqual([false]);
    expect(await outdatedOf(earlier(), NOW, at(then, file("2")))).toEqual([false]);
    expect(await outdatedOf(earlier(), NOW, at(then, file("")))).toEqual([false]);
  });
});

describe("GET /api/pulls/findings/earlier", () => {
  const ask = (a: Awaited<ReturnType<typeof signInWithGithub>>, head: string) =>
    a.send(`/api/pulls/findings/earlier?platform=github&repo=octo/api&number=7&head=${head}`);

  it("answers an earlier head's open finding with its head, and none at that head", async () => {
    githubFake();
    const a = await signInWithGithub();
    const { id } = await seed("https://github.com/octo/api", 7);
    const later = (await (await ask(a, NOW)).json()) as {
      findings: { id: string; head: string; outdated: boolean }[];
    };
    expect(later.findings.map((f) => [f.id, f.head, f.outdated])).toEqual([[id, HEAD, false]]);
    expect(await (await ask(a, HEAD)).json()).toEqual({ findings: [] });
  });
});
