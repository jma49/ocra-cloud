import { beforeEach, describe, expect, it } from "vitest";
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
});
