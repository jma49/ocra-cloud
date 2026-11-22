import { Hono } from "hono";
import { z } from "zod";
import { recordGithubClose } from "./auto-review/closes.js";
import { recordGithubFlow } from "./auto-review/flows.js";
import { queueGithubComment } from "./auto-review/replies.js";
import type { AutoReviewService } from "./auto-review/routes.js";
import { queueGithubPull } from "./auto-review/webhooks.js";
import { hmacHex, sameText } from "./crypto.js";
import { defer } from "./defer.js";
import type { GraphService } from "./graph/routes.js";
import { MAX_HOOK_BODY, queueGithubPush } from "./graph/webhooks.js";
import { signedBody } from "./http.js";
import { publicOutbox } from "./notify/notify.js";
import { tellGithubHook } from "./notify/pull-hooks.js";
import type { AppEnv } from "./types.js";

// The GitHub App's one webhook, proven by its signature: a push queues
// graph builds, a pull request's change queues its review (its merge or
// close is recorded, as are its steps toward review, and its user told of
// what concerns them) and an @ocra comment its answer, where the host does them. GitLab's hooks are per
// repository, with secrets of their own.

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
      const event = c.req.header("x-github-event");
      const review = host.autoReview;
      // A close is kept wherever the repository is enrolled, reviews or not.
      if (event === "pull_request") await recordGithubClose(c.var.db, body);
      await recordGithubFlow(c.var.db, event, body);
      defer(c, tellGithubHook(c.var.db, publicOutbox(c), event, body));
      const queued =
        event === "push" && host.graphs
          ? await queueGithubPush(c.var.db, host.graphs, body)
          : event === "pull_request" && review
            ? await queueGithubPull(c, review, body)
            : (event === "issue_comment" || event === "pull_request_review_comment") && review
              ? await queueGithubComment(c.var.db, review, event, body)
              : 0;
      return c.json({ queued }, 202);
    },
  );
  return hook;
}
