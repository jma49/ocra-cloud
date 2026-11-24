import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullReviewChangesView } from "../src/shared/index.js";
import { HEAD, seed } from "./fix-fakes.js";
import { resetDb } from "./helpers.js";
import { githubFake, signInWithGithub } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// How far a pull request moved since ocra's latest review of it, and
// whether its page offers to review only the changes: on a repository
// reviewed only when asked, after a review that left findings open.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const H2 = "2".repeat(40);
const H3 = "3".repeat(40);
const REPO = "https://api.github.com/repos/octo/api";

function platform(routes: Record<string, () => Response>) {
  githubFake({
    extra: async (req) => routes[`${req.method} ${req.url}`]?.(),
  });
}

const github = (head: string, compare: () => Response) =>
  platform({
    [`GET ${REPO}/pulls/7`]: () =>
      Response.json({ base: { sha: "c".repeat(40) }, head: { sha: head }, changed_files: 1 }),
    "POST https://api.github.com/graphql": () =>
      Response.json({
        data: {
          repository: {
            pullRequest: {
              headRefOid: head,
              commits: { nodes: [{ commit: { committedDate: "2026-11-22T09:00:00Z" } }] },
              timelineItems: { totalCount: 0, nodes: [] },
            },
          },
        },
      }),
    [`GET ${REPO}/compare/${HEAD}...${head}`]: compare,
  });

/** octo/api enrolled, reviewed as asked or on every push, with a review of HEAD leaving one finding open. */
async function reviewed(automatic: boolean) {
  const a = await signInWithGithub();
  const { data, reviewId } = await seed("https://github.com/octo/api", 7);
  await data.insert("reviewRepos", {
    ...rows.reviewRepos("r"),
    platformRepoId: "11",
    fullName: "octo/api",
    automatic,
  });
  for (const [head, day, opened] of [
    [HEAD, 20, true],
    [H2, 21, false],
    [H3, 22, false],
  ] as const) {
    await data.pullVersions.record("r", 7, {
      head,
      pushedAt: new Date(`2026-11-${day}T10:00:00Z`),
      opened,
    });
  }
  const changes = async () => {
    const res = await a.send("/api/pulls/review-changes?platform=github&repo=octo/api&number=7");
    expect(res.status).toBe(200);
    return (await res.json()) as PullReviewChangesView;
  };
  return { changes, reviewId, data };
}

describe("changes since ocra's last review", () => {
  it("counts the commits and versions since the reviewed head, and offers to review them", async () => {
    github(H3, () => Response.json({ status: "ahead", total_commits: 4, files: [] }));
    const { changes, reviewId } = await reviewed(false);
    expect(await changes()).toEqual({
      platform: "github",
      repo: "octo/api",
      number: 7,
      head: H3,
      review: { id: reviewId, head: HEAD, at: expect.any(String) },
      state: "changes",
      commits: 4,
      versions: 2,
      openFindings: 1,
      automatic: false,
      reviewChanges: true,
    });
  });

  it("offers nothing where every push is reviewed, or no finding is open", async () => {
    github(H3, () => Response.json({ status: "ahead", total_commits: 4, files: [] }));
    const { changes, data } = await reviewed(true);
    expect(await changes()).toMatchObject({ commits: 4, automatic: true, reviewChanges: false });
    await data.update("reviewRepos", "r", { automatic: false });
    const [finding] = await data.list("findings");
    await data.decide([finding?.id ?? ""], {
      status: "fixed",
      reason: null,
      note: null,
      decidedAt: new Date(),
    });
    expect(await changes()).toMatchObject({ openFindings: 0, reviewChanges: false });
  });

  it("says a rebase left the reviewed head out, still offering the review", async () => {
    github(H3, () => Response.json({ status: "diverged", files: [] }));
    const { changes } = await reviewed(false);
    expect(await changes()).toMatchObject({
      state: "rebased",
      commits: null,
      versions: 2,
      reviewChanges: true,
    });
  });

  it("says same at the reviewed head, and none with no review", async () => {
    github(HEAD, () => Response.json({}, { status: 500 }));
    const { changes, data, reviewId } = await reviewed(false);
    expect(await changes()).toMatchObject({
      state: "same",
      commits: 0,
      versions: 0,
      reviewChanges: false,
    });
    await data.remove("reviews", reviewId);
    expect(await changes()).toMatchObject({ review: null, state: "none", reviewChanges: false });
  });
});
