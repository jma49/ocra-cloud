import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullLinesView } from "../src/shared/index.js";
import { resetDb } from "./helpers.js";
import { githubBlobs, githubHead, OTHER, PR_HEAD, platform } from "./learning-fakes.js";
import { signInWithGithub } from "./platform-fakes.js";

// Unchanged lines of a pull request's file at its head, read as the user,
// so the page can open what its diff left out.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const TEXT = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  .join("\r\n")
  .concat("\r\n");
const asked: Record<string, string>[] = [];

function github() {
  asked.length = 0;
  const blobs = githubBlobs({ "src/a.ts": { oid: OTHER, text: TEXT } });
  platform(githubHead, (variables) => {
    asked.push(variables);
    return blobs(variables);
  });
}

const query = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    platform: "github",
    repo: "octo/api",
    number: "3",
    head: PR_HEAD,
    path: "src/a.ts",
    from: "11",
    to: "13",
    ...over,
  }).toString();

it("answers the lines asked for at the head the page shows, and the file's length", async () => {
  github();
  const { send } = await signInWithGithub();
  const res = await send(`/api/pulls/lines?${query()}`);
  expect(res.status).toBe(200);
  expect((await res.json()) as PullLinesView).toEqual({
    path: "src/a.ts",
    head: PR_HEAD,
    from: 11,
    lines: ["line 11", "line 12", "line 13"],
    total: 30,
  });
  expect(asked[0]?.e0).toBe(`${PR_HEAD}:src/a.ts`);
});

it("answers past the file's end with what there is", async () => {
  github();
  const { send } = await signInWithGithub();
  const body = (await (
    await send(`/api/pulls/lines?${query({ from: "29", to: "48" })}`)
  ).json()) as PullLinesView;
  expect(body.lines).toEqual(["line 29", "line 30"]);
});

it("refuses a path leaving the repository, a head that is not a commit and a range too long, unsent", async () => {
  github();
  const { send } = await signInWithGithub();
  for (const over of [
    { path: "src/../../etc/passwd" },
    { path: "/src/a.ts" },
    { head: "main" },
    { from: "10", to: "9" },
    { from: "1", to: "1001" },
  ]) {
    expect((await send(`/api/pulls/lines?${query(over)}`)).status).toBe(404);
  }
  expect(asked).toEqual([]);
});

it("says a file that is not there is not found", async () => {
  github();
  const { send } = await signInWithGithub();
  expect((await send(`/api/pulls/lines?${query({ path: "src/gone.ts" })}`)).status).toBe(404);
});
