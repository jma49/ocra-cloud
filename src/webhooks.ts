import { Hono } from "hono";
import { z } from "zod";
import { recordGithubClose } from "./auto-review/closes.js";
import { recordGithubFlow } from "./auto-review/flows.js";
import { queueGithubComment } from "./auto-review/replies.js";
import { recordGithubRequest } from "./auto-review/requests.js";
import type { AutoReviewService } from "./auto-review/routes.js";
import { queueGithubPull } from "./auto-review/webhooks.js";
import { hmacHex, sameText } from "./crypto.js";
import type { GraphService } from "./graph/routes.js";
import { MAX_HOOK_BODY, queueGithubPush } from "./graph/webhooks.js";
import { signedBody } from "./http.js";
import { githubFields } from "./inbound/fields.js";
import { receive } from "./inbound/receive.js";
import type { InboundStep } from "./inbound/run.js";
import { rerunGithubChecks } from "./merge-checks/rerun.js";
import { githubHostOf } from "./platforms/registry.js";
import type { AppEnv } from "./types.js";

// The GitHub App's one webhook, proven by its signature: a push queues
// graph builds, a pull request's change queues its review (its merge or
// close is recorded, as are its steps toward review and the directories a
// reviewed one changes, and its user told of what concerns them), an @ocra
// comment its answer and a re-run of the pre-merge check its evaluation,
// where the host does them. A pull request's change, review, check or status also moves the
// intents armed to merge it when ready. Each delivery is acted on once,
// and what runs after the answer is tried again when it fails (src/inbound/).
// GitLab's hooks are per repository, with secrets of their own.

/** The events whose side effects tell the account's channels (src/notify/pull-hooks.ts). */
const TELLS = new Set([
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "pull_request_review_comment",
]);
/** The events that may move merge-when-ready intents (src/merge-when-ready/hooks.ts). */
const SIGNALS = new Set([
  "pull_request",
  "pull_request_review",
  "check_suite",
  "check_run",
  "status",
]);

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
      const github = githubHostOf(c.env).host;
      const repo = z.object({ repository: z.object({ id: z.number() }) }).safeParse(body);
      const steps: InboundStep[] = [
        ...(TELLS.has(event) ? (["tell"] as const) : []),
        ...(SIGNALS.has(event) ? (["intents"] as const) : []),
      ];
      const received = await receive(c, {
        platform: "github",
        host: github,
        deliveryId: c.req.header("x-github-delivery"),
        event,
        repo: repo.success ? String(repo.data.repository.id) : "",
        work: { steps, ...(steps.length > 0 ? { body: githubFields(body) } : {}) },
      });
      if (!received) return c.json({ queued: 0, duplicate: true }, 202);
      const queued = await received.answer(async () => {
        // A close is kept wherever the repository is enrolled, reviews or not.
        if (event === "pull_request") await recordGithubClose(c.var.db, github, body);
        received.reviewed(await recordGithubFlow(c.var.db, github, event, body));
        await recordGithubRequest(c.var.db, github, event, body);
        return event === "push" && host.graphs
          ? await queueGithubPush(c.var.db, github, host.graphs, body)
          : event === "pull_request" && review
            ? await queueGithubPull(c, review, body)
            : (event === "issue_comment" || event === "pull_request_review_comment") && review
              ? await queueGithubComment(c.var.db, github, review, event, body)
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
