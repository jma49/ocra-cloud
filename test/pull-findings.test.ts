import { beforeEach, describe, expect, it } from "vitest";
import type { Row } from "../src/db/scoped.js";
import { headReview } from "../src/merge-checks/run.js";
import type { CodePlatform } from "../src/platforms/platform.js";
import { HEAD, seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's open findings for its page's diff, of the review of the
// head the page shows.

beforeEach(resetDb);

const findings = (a: Awaited<ReturnType<typeof signInWithGithub>>, head = HEAD) =>
  a.send(`/api/pulls/findings?platform=github&repo=octo/api&number=7&head=${head}`);

describe("a pull request's findings", () => {
  it("answers each open finding with its lines, and whether a fix goes with it", async () => {
    githubFake();
    const a = await signInWithGithub();
    const { id, reviewId } = await seed("https://github.com/octo/api", 7);
    const res = await findings(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      review: { id: reviewId, head: HEAD },
      findings: [
        {
          id,
          review: reviewId,
          severity: "critical",
          title: "SQL built from input",
          body: "The query concatenates user input.",
          file: "src/db.ts",
          lineStart: 10,
          lineEnd: 12,
          hasFix: true,
          lowConfidence: false,
        },
      ],
    });
  });

  it("answers none for a head no review was of: its lines are not that diff's", async () => {
    githubFake();
    const a = await signInWithGithub();
    await seed("https://github.com/octo/api", 7);
    expect(await (await findings(a, "b".repeat(40))).json()).toEqual({
      review: null,
      findings: [],
    });
  });

  it("leaves out a finding marked fixed or dismissed, and is not found without a head", async () => {
    githubFake();
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/octo/api", 7);
    await data.decide([id], { status: "fixed", reason: null, note: null, decidedAt: new Date() });
    expect(((await (await findings(a)).json()) as { findings: unknown[] }).findings).toEqual([]);
    expect((await a.send("/api/pulls/findings?platform=github&repo=octo/api")).status).toBe(404);
  });

  it("keeps an earlier review's open finding when a later review of the same head does not report it", async () => {
    githubFake();
    const a = await signInWithGithub();
    const first = await seed("https://github.com/octo/api", 7);
    const later = await seed(
      "https://github.com/octo/api",
      7,
      { fingerprint: "fp-other", title: "Another one" },
      "run-2",
    );
    const answer = (await (await findings(a)).json()) as {
      review: { id: string };
      findings: { id: string; review: string }[];
    };
    expect(answer.review.id).toBe(later.reviewId);
    expect(answer.findings.map((f) => [f.id, f.review])).toEqual([
      [later.id, later.reviewId],
      [first.id, first.reviewId],
    ]);
  });

  it("takes the later review's word on a finding both reviews hold", async () => {
    githubFake();
    const a = await signInWithGithub();
    await seed("https://github.com/octo/api", 7);
    const later = await seed("https://github.com/octo/api", 7, {}, "run-2");
    const ids = async () =>
      ((await (await findings(a)).json()) as { findings: { id: string }[] }).findings.map(
        (f) => f.id,
      );
    expect(await ids()).toEqual([later.id]);
    await later.data.decide([later.id], {
      status: "dismissed",
      reason: "false_positive",
      note: null,
      decidedAt: new Date(),
    });
    expect(await ids()).toEqual([]);
  });

  it("counts an earlier review's open critical finding for the head's merge check", async () => {
    githubFake();
    await signInWithGithub();
    const first = await seed("https://github.com/octo/api", 7);
    await seed(
      "https://github.com/octo/api",
      7,
      { fingerprint: "fp-other", severity: "warning" },
      "run-2",
    );
    const github = { url: "https://github.com" } as CodePlatform;
    const repo = { fullName: "octo/api" } as Row<"reviewRepos">;
    const unresolved = async () =>
      (await headReview(first.data, github, repo, 7, HEAD))?.unresolvedCritical;
    expect(await unresolved()).toBe(1);
    await first.data.decide([first.id], {
      status: "fixed",
      reason: null,
      note: null,
      decidedAt: new Date(),
    });
    expect(await unresolved()).toBe(0);
  });
});
