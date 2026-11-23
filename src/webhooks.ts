import { Hono } from "hono";
import { z } from "zod";
import { githubInstallationAdds } from "./auto-review/auto-enroll.js";
import { recordGithubClose } from "./auto-review/closes.js";
import { recordGithubFindingThread } from "./auto-review/finding-threads.js";
import { recordGithubFlow } from "./auto-review/flows.js";
import { githubLifecycle } from "./auto-review/lifecycle.js";
import { queueGithubComment } from "./auto-review/replies.js";
import { recordGithubRequest } from "./auto-review/requests.js";
import type { AutoReviewService } from "./auto-review/routes.js";
import { queueGithubPull } from "./auto-review/webhooks.js";
import { automatePullEvents, githubPullEvents } from "./automations/pull-events.js";
import { hmacHex, sameText } from "./crypto.js";
import { touchPulls } from "./db/pull-changes.js";
import type { GraphService } from "./graph/routes.js";
import { MAX_HOOK_BODY, queueGithubPush } from "./graph/webhooks.js";
import { signedBody } from "./http.js";
import { githubFields } from "./inbound/fields.js";
import { receive } from "./inbound/receive.js";
import { githubSteps } from "./inbound/steps.js";
import { rerunGithubChecks } from "./merge-checks/rerun.js";
import { githubCiFailure } from "./notify/ci-hooks.js";
import { githubHostOf } from "./platforms/registry.js";
import { githubTouchesPulls } from "./pull-changes.js";
import { githubMovesChecks, indexGithubEvent } from "./pull-index/hooks.js";
import type { AppEnv } from "./types.js";

// The GitHub App's one webhook, proven by its signature: a push queues
// graph builds, a pull request's change queues its review (its merge or
// close is recorded, as are its steps toward review and the directories a
// reviewed one changes, and its user told of what concerns them; what
// people do to the thread of a finding's comment is kept, and its merge,
// approval, failed CI, label or leaving draft runs the automation rules on
// it), an @ocra
// comment its answer and a re-run of the pre-merge check its evaluation,
// where the host does them. A pull request's change, review, check or status also moves the
// intents armed to merge it when ready, and a failed check suite tells the
// author of its pull request; the repositories added to an installation
// are enrolled where an account asked for that; a repository renamed,
// transferred, deleted or removed, or an installation suspended or
// uninstalled, changes the enrollments it names (src/auto-review/lifecycle.ts); one that changes a pull
// request of an enrolled repository moves its change time, which the inbox
// watches. Each delivery with something to
// run after the answer is acted on once, and that is tried again when it
// fails (src/inbound/).
// GitLab's hooks are per repository, with secrets of their own.

export type WebhookHost = {
  githubWebhookSecret?: string;
  graphs?: GraphService;
  autoReview?: AutoReviewService;
};

export function githubWebhook(host: WebhookHost) {
  const hook = new Hono<AppEnv>();
  hook.post(
    "/",
    signedBody(
      z.looseObject({}),
      async (c, raw) => {
        const secret = host.githubWebhookSecret;
        const signature = c.req.header("x-hub-signature-256") ?? "";
        return !!secret && sameText(signature, `sha256=${await hmacHex(secret, raw)}`);
      },
      MAX_HOOK_BODY,
    ),
    async (c) => {
      const body = c.req.valid("json");
      const event = c.req.header("x-github-event") ?? "";
      const review = host.autoReview;
      const { host: github, url: githubUrl } = githubHostOf(c.env);
      const repo = z.object({ repository: z.object({ id: z.number() }) }).safeParse(body);
      const ci = githubCiFailure(event, body, review?.githubAppId);
      const steps = await githubSteps(c.var.db, github, event, body, !!ci);
      const enroll = githubInstallationAdds(event, body);
      const received = await receive(c, {
        platform: "github",
        host: github,
        deliveryId: c.req.header("x-github-delivery"),
        event,
        repo: repo.success ? String(repo.data.repository.id) : "",
        work: {
          steps,
          ...(steps.length > 0 ? { body: githubFields(body) } : {}),
          ...(ci && steps.includes("tell") ? { ci } : {}),
          ...(enroll && steps.includes("enroll") ? { enroll } : {}),
        },
      });
      if (!received) return c.json({ queued: 0, duplicate: true }, 202);
      const queued = await received.answer(async () => {
        if (repo.success && githubTouchesPulls(event, body)) {
          await touchPulls(c.var.db, "github", github, String(repo.data.repository.id), new Date());
        }
        if (repo.success && (githubTouchesPulls(event, body) || githubMovesChecks(event))) {
          await indexGithubEvent(c.var.db, github, event, body);
        }
        const site = { kind: "github" as const, host: github, url: githubUrl };
        await githubLifecycle(c.var.db, site, event, body, new Date());
        // A close is kept wherever the repository is enrolled, reviews or not.
        if (event === "pull_request") await recordGithubClose(c.var.db, github, body);
        received.reviewed(await recordGithubFlow(c.var.db, github, event, body));
        await recordGithubRequest(c.var.db, github, event, body);
        await recordGithubFindingThread(c.var.db, github, githubUrl, event, body);
        await automatePullEvents(
          c,
          await githubPullEvents(c.var.db, github, event, body, review?.githubAppId),
        );
        return event === "push" && host.graphs
          ? await queueGithubPush(c.var.db, github, host.graphs, body)
          : event === "pull_request" && review
            ? await queueGithubPull(c, review, body)
            : (event === "issue_comment" || event === "pull_request_review_comment") && review
              ? await queueGithubComment(c, github, review, event, body)
              : review
                ? await rerunGithubChecks(c.var.db, github, review, event, body)
                : 0;
      });
      await received.start();
      return c.json({ queued }, 202);
    },
  );
  return hook;
}
