import { afterEach, describe, expect, it, vi } from "vitest";
import { githubAutoMerge } from "../src/platforms/github-auto-merge.js";
import { githubHost } from "../src/platforms/github-host.js";
import { githubQueue } from "../src/platforms/github-queue.js";

afterEach(() => vi.restoreAllMocks());

const host = githubHost("https://github.example.com");
const head = "a".repeat(40);
const repository = {
  autoMergeAllowed: true,
  pullRequest: {
    id: "PR_7",
    headRefOid: head,
    mergeQueue: { id: "MQ_1" },
    mergeQueueEntry: null,
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: null,
  },
};

describe.each([
  {
    mutation: "enqueuePullRequest",
    run: () => githubQueue(host).enqueue("t", "octo/api", 7, head),
  },
  {
    mutation: "enablePullRequestAutoMerge",
    run: () => githubAutoMerge(host).enable("t", "octo/api", 7, { method: "squash", head }),
  },
])("GitHub's $mutation", ({ mutation, run }) => {
  it.each([
    { response: "network failure", status: null, errors: [], outcome: null },
    { response: "HTTP 503", status: 503, errors: ["FORBIDDEN"], outcome: null },
    { response: "HTTP 422", status: 422, errors: ["UNPROCESSABLE"], outcome: "refused" },
    {
      response: "permission error",
      status: 200,
      errors: ["OTHER", "FORBIDDEN"],
      outcome: "refused",
    },
    { response: "other error", status: 200, errors: ["UNPROCESSABLE"], outcome: "not_mergeable" },
    { response: "success", status: 200, errors: [], outcome: "done" },
  ])("classifies $response", async ({ status, errors, outcome }) => {
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: { repository } }));
    if (status === null) send.mockRejectedValue(new TypeError("unreachable"));
    else {
      send.mockImplementation(async () =>
        Response.json(
          errors.length
            ? { errors: errors.map((type) => ({ type })) }
            : { data: { [mutation]: {} } },
          { status },
        ),
      );
    }
    expect(await run()).toBe(outcome);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      2,
      host.graphql,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(mutation),
      }),
    );
  });
});
