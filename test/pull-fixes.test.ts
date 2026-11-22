import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE, HEAD, seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";

// A pull request's open fixes beside the lines they replace, read at the
// reviewed head as the signed-in user.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const MOVED = "b".repeat(40);

/** Answers the GraphQL read of src/db.ts at HEAD with `text`; records each read's variables. */
function fileAtHead(text: string | null) {
  const reads: Record<string, string>[] = [];
  githubFake({
    extra: async (req) => {
      if (req.method !== "POST" || req.url !== "https://api.github.com/graphql") return undefined;
      const { variables } = (await req.json()) as { variables: Record<string, string> };
      reads.push(variables);
      const b0 =
        text === null
          ? null
          : {
              oid: "c".repeat(40),
              byteSize: text.length,
              isBinary: false,
              isTruncated: false,
              text,
            };
      return Response.json({ data: { repository: { b0, at: null } } });
    },
  });
  return reads;
}

const fixes = (a: Awaited<ReturnType<typeof signInWithGithub>>, head = HEAD) =>
  a.send(`/api/pulls/fixes?platform=github&repo=octo/api&number=7&head=${head}`);

describe("a pull request's fixes", () => {
  it("answers each open fix with the lines it replaces at the reviewed head", async () => {
    const reads = fileAtHead(FILE);
    const a = await signInWithGithub();
    const { id, reviewId } = await seed("https://github.com/octo/api", 7);
    const res = await fixes(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      review: { id: reviewId, head: HEAD },
      fixes: [
        {
          finding: id,
          title: "SQL built from input",
          severity: "critical",
          file: "src/db.ts",
          startLine: 2,
          endLine: 2,
          before: ["const b = 2;"],
          after: ["const b = 20;"],
        },
      ],
    });
    expect(reads[0]).toMatchObject({
      owner: "octo",
      name: "api",
      oid: HEAD,
      e0: `${HEAD}:src/db.ts`,
    });
  });

  it("answers no review, and reads nothing, for a head no review was of", async () => {
    const reads = fileAtHead(FILE);
    const a = await signInWithGithub();
    await seed("https://github.com/octo/api", 7);
    expect(await (await fixes(a, MOVED)).json()).toEqual({ review: null, fixes: [] });
    expect(reads).toEqual([]);
  });

  it("leaves out a finding marked fixed or dismissed", async () => {
    fileAtHead(FILE);
    const a = await signInWithGithub();
    const { id, data } = await seed("https://github.com/octo/api", 7);
    await data.decide([id], { status: "fixed", reason: null, note: null, decidedAt: new Date() });
    const body = (await (await fixes(a)).json()) as { fixes: unknown[] };
    expect(body.fixes).toEqual([]);
  });

  it("keeps the fix without its old lines when the file no longer has them", async () => {
    fileAtHead("only one line\n");
    const a = await signInWithGithub();
    await seed("https://github.com/octo/api", 7);
    const body = (await (await fixes(a)).json()) as { fixes: { before: unknown }[] };
    expect(body.fixes[0]?.before).toBeNull();
  });
});

describe("a review's fixes", () => {
  it("reads them at the head the review was of", async () => {
    const reads = fileAtHead(FILE);
    const a = await signInWithGithub();
    const { reviewId } = await seed("https://github.com/octo/api", 7);
    const res = await a.send(`/api/pulls/fixes/review/${reviewId}`);
    const body = (await res.json()) as { fixes: { before: string[] }[] };
    expect(body.fixes[0]?.before).toEqual(["const b = 2;"]);
    expect(reads[0]?.oid).toBe(HEAD);
  });

  it("is not found for a review of no pull request", async () => {
    fileAtHead(FILE);
    const a = await signInWithGithub();
    expect((await a.send("/api/pulls/fixes/review/nope")).status).toBe(404);
  });
});
