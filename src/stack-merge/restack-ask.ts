import { type Context, Hono } from "hono";
import { z } from "zod";
import { restackJobView } from "../auto-review/restack-routes.js";
import type { Row } from "../db/scoped.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { stackOf } from "../platforms/stacks.js";
import { byKind, reach } from "../pull-page.js";
import { pullRef, sha } from "../pull-ref.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { PullRestackAnswer, PullRestackView } from "../shared/index.js";
import type { AppEnv } from "../types.js";
import { enrolledRepo, safeBranch } from "./restack.js";

// A restack asked for on a pull request's page: the layer rebased onto the
// head of the one it is stacked on, by the same job a merge queues
// (./restack.ts), with the same switch and the same lease on its head. No
// one recorded where the layer below was when this one branched, so its run
// drops what the two branches share (src/node/restack-run.ts).

export const restackAsk = new Hono<AppEnv>();

const query = z.object(pullRef);
/** The heads the page read: the layer's, and the one it is stacked on. */
const askBody = z.object({ ...pullRef, head: sha, parentHead: sha });

const view = (repo: Row<"reviewRepos"> | undefined, job: Row<"restackJobs"> | undefined) =>
  ({
    enrolled: repo !== undefined,
    offered: repo?.restack === true,
    job: job ? restackJobView(job) : null,
  }) satisfies PullRestackView;

const answer = (
  c: Context<AppEnv>,
  outcome: PullRestackAnswer["outcome"],
  repo: Row<"reviewRepos">,
  job: Row<"restackJobs"> | undefined,
) => c.json({ outcome, ...view(repo, job) } satisfies PullRestackAnswer);

restackAsk.get("/", requireSession(["web"]), async (c) => {
  const ref = query.safeParse(c.req.query());
  if (!ref.success) return apiError(c, "not_found");
  const platform = platformsOf(c.env, c.req.url).find(byKind(ref.data));
  if (!platform) return apiError(c, "not_found");
  const data = c.var.data;
  const key = { platform: platform.kind, host: platform.host, fullName: ref.data.repo };
  const repo = await enrolledRepo(data, key);
  const job = repo && (await data.restacks.newestOf(repo.id, ref.data.number));
  return c.json(view(repo, job));
});

restackAsk.post(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(askBody),
  async (c) => {
    const { repo: fullName, number, head, parentHead } = c.req.valid("json");
    const reached = await reach(c, byKind(c.req.valid("json")));
    if ("refusal" in reached) return reached.refusal;
    const { platform, token } = reached;
    const data = c.var.data;
    const key = { platform: platform.kind, host: platform.host, fullName };
    const repo = await enrolledRepo(data, key);
    if (!repo?.restack) return apiError(c, "not_found");
    const newest = await data.restacks.newestOf(repo.id, number);
    if (newest?.state === "queued" || newest?.state === "running") {
      return answer(c, "running", repo, newest);
    }
    if (await data.stackMerges.heldBy(key, [number])) return answer(c, "held", repo, newest);
    const open = await platform.stacks.open(token, fullName);
    if (!open) return apiError(c, "upstream_unreachable");
    const pulls = stackOf(open, number)?.pulls ?? [];
    const layer = pulls.find((p) => p.number === number);
    const parent = layer && pulls.find((p) => p.number === layer.parent);
    if (!layer || !parent) return apiError(c, "not_found");
    // Heads that moved since the page read them are not rebased on the page's word.
    if (layer.headSha !== head || parent.headSha !== parentHead) {
      return answer(c, "stack_changed", repo, newest);
    }
    if (!safeBranch(layer.head) || !safeBranch(parent.head)) return apiError(c, "invalid_body");
    await data.restacks.ask({
      reviewRepoId: repo.id,
      number,
      parentMerge: `asked:${parentHead}:${head}`,
      parent: parent.number,
      branch: layer.head,
      head,
      ontoBranch: parent.head,
      ontoCommit: parentHead,
      upstream: parentHead,
      askedBy: c.var.session.account.login,
    });
    return answer(c, "queued", repo, await data.restacks.newestOf(repo.id, number));
  },
);
