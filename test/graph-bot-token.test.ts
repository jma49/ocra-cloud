import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { scoped } from "../src/db/scoped.js";
import { assignBuild } from "../src/graph/runner-api.js";
import { botTokens } from "../src/platforms/bot-tokens.js";
import { platformsOf } from "../src/platforms/registry.js";
import { sealRepoToken } from "../src/platforms/repo-token.js";
import { db, ORIGIN, resetDb, signIn } from "./helpers.js";

// A remote runner clones a GitLab project to build its code graph with the
// token its reviews use: the project's own access token where the account
// gave one, else the deployment's GITLAB_BOT_TOKEN.

beforeEach(resetDb);

const COMMIT = "c".repeat(40);
const OWN = "glpat-project-own-token";
const SHARED = "glpat-deployment-bot-token";
const platforms = platformsOf(env, ORIGIN);
const lab = platforms.find((p) => p.kind === "gitlab");
const bots = botTokens({
  githubApi: "https://api.github.com",
  gitlabBotToken: SHARED,
  masterKeys: { current: env.MASTER_KEY },
});

async function queued(project: string, ownToken?: string) {
  const { account } = await signIn(1, "octo");
  const data = scoped(db, account.id);
  const repo = {
    platform: "gitlab" as const,
    host: lab?.host ?? "",
    platformRepoId: project,
    fullName: `acme/${project}`,
  };
  const graphRepoId = await data.insert("graphRepos", { ...repo, branch: "main" });
  const id = await data.insert("reviewRepos", repo);
  if (ownToken) {
    const sealed = await sealRepoToken(env.MASTER_KEY, { accountId: account.id, id }, ownToken);
    await data.update("reviewRepos", id, {
      accessTokenWrappedKey: sealed.wrappedKey,
      accessTokenCiphertext: sealed.ciphertext,
    });
  }
  await data.graphs.queueBuild(graphRepoId, COMMIT);
  return graphRepoId;
}

describe("a GitLab graph build given to a remote runner", () => {
  it("carries the project's own access token", async () => {
    const graphRepoId = await queued("11", OWN);
    const assigned = await assignBuild({ db, platforms, bots });
    expect(assigned?.graphRepoId).toBe(graphRepoId);
    expect(assigned?.bot.token).toBe(OWN);
  });

  it("carries GITLAB_BOT_TOKEN for a project without one", async () => {
    await queued("12");
    const assigned = await assignBuild({ db, platforms, bots });
    expect(assigned?.bot.token).toBe(SHARED);
  });
});
