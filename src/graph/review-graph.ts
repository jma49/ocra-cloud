import { MAX_GRAPH_REPOS } from "@open-cr-agent/cloud-contract";
import type { scoped } from "../db/scoped.js";
import type { BotCredential } from "../platforms/bot.js";
import { COMMIT_ID } from "../platforms/contents.js";
import type { CodePlatform } from "../platforms/platform.js";
import type { GraphService } from "./routes.js";

type ReviewedRepo = { platform: CodePlatform["kind"]; platformRepoId: string; fullName: string };

/**
 * The graph repository a review of `repo` reads and answers to: the one the
 * account keeps of it, or, where the deployment keeps graphs without asking,
 * one added now with its first build queued. Undefined where none is kept.
 */
export async function reviewGraphRepo(
  service: GraphService,
  data: ReturnType<typeof scoped>,
  platform: CodePlatform,
  repo: ReviewedRepo,
  bot: BotCredential,
): Promise<string | undefined> {
  const kept = await data.findOne("graphRepos", {
    platform: repo.platform,
    host: platform.host,
    platformRepoId: repo.platformRepoId,
  });
  if (kept || service.policy !== "keep") return kept?.id;
  const head = await platform.contents.head(bot.token, repo.fullName);
  if (!head || head.platformRepoId !== repo.platformRepoId || !COMMIT_ID.test(head.commit)) {
    return undefined;
  }
  const id = await data.graphs.addRepo(
    {
      platform: repo.platform,
      host: platform.host,
      platformRepoId: head.platformRepoId,
      fullName: head.fullName,
      branch: head.branch,
      webhookSecretHash: null,
      consentedAt: null,
    },
    service.remote?.maxRepos ?? MAX_GRAPH_REPOS,
  );
  if (id && (await data.graphs.queueBuild(id, head.commit))) service.kick();
  return id;
}
