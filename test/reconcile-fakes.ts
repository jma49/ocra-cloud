import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as schema from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import worker from "../src/index.js";
import { saveToken } from "../src/platforms/links.js";
import { platformsOf } from "../src/platforms/registry.js";
import { db, ORIGIN, signIn } from "./helpers.js";
import { GITLAB } from "./platform-fakes.js";
import { rows } from "./table-rows.js";

// What the daily reconciliation's tests share: the hourly run, and an
// account with enrolled repositories and platform links.

const DAY = 24 * 60 * 60_000;

/** One hourly scheduled run of the Worker. */
export async function hourly() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "47 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const [github, gitlab] = (() => {
  const all = platformsOf(env, ORIGIN);
  return [all.find((p) => p.kind === "github"), all.find((p) => p.kind === "gitlab")];
})();

/** An account linked to GitHub and GitLab, with enrolled repositories enrolled a day ago. */
export async function account(
  n: number,
  repos: { name: string; platform?: "github" | "gitlab" }[],
) {
  const { account } = await signIn(n, `user-${n}`);
  const data = scoped(db, account.id);
  for (const p of [github, gitlab]) {
    if (p) await saveToken(data, env, p, { access_token: `token-${n}-${p.kind}` });
  }
  for (const repo of repos) {
    const platform = repo.platform ?? "github";
    await db.insert(schema.reviewRepos).values({
      ...rows.reviewRepos(`${account.id}-${repo.name}`),
      accountId: account.id,
      platform,
      host: platform === "github" ? "github.com" : new URL(GITLAB).host,
      fullName: repo.name,
      createdAt: new Date(Date.now() - DAY),
    });
  }
  return { id: account.id, data, repo: (name: string) => `${account.id}-${name}` };
}
