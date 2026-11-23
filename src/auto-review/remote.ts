import type { BotTokens } from "../platforms/bot.js";
import { type BotSettings, botTokens } from "../platforms/bot-tokens.js";
import { githubHostOf } from "../platforms/registry.js";

// A host that runs no job itself (the Worker) still reviews pull requests
// when remote runners ask it for them (./runner-api.ts): it needs the token
// its runners prove themselves with and a bot on at least one platform: the
// GitHub App's key with its webhook secret, or GitLab's bot token, whose
// webhooks each enrolled project proves with its own secret.

type Vars = {
  GITHUB_URL?: string | undefined;
  GITHUB_APP_ID?: string | undefined;
  GITHUB_APP_PRIVATE_KEY?: string | undefined;
  GITHUB_WEBHOOK_SECRET?: string | undefined;
  GITLAB_BOT_TOKEN?: string | undefined;
  RUNNER_TOKEN?: string | undefined;
};

/** A token short enough to guess is refused: `openssl rand -base64 32` gives 44 characters. */
const MIN_TOKEN = 32;

export function runnerTokenFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length < MIN_TOKEN) {
    throw new Error(
      `RUNNER_TOKEN must be at least ${MIN_TOKEN} characters (openssl rand -base64 32)`,
    );
  }
  return value;
}

/** The bot's settings as the variables give them: a key pasted on one line keeps its line breaks as \n. */
export const botSettingsFrom = (vars: Vars) =>
  ({
    githubApi: githubHostOf(vars.GITHUB_URL ? { GITHUB_URL: vars.GITHUB_URL } : {}).api,
    githubAppId: vars.GITHUB_APP_ID || undefined,
    githubAppPrivateKey: vars.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") || undefined,
    gitlabBotToken: vars.GITLAB_BOT_TOKEN || undefined,
  }) satisfies BotSettings;

type RemoteReviews = {
  autoReview: { kick: () => void; remote: true; githubAppId?: string };
  bots: BotTokens;
  runnerToken: string;
  githubWebhookSecret?: string;
};

/** What the app needs to queue jobs for remote runners; nothing without a runner token and a whole bot. */
export function remoteReviews(vars: Vars): RemoteReviews | Record<string, never> {
  const runnerToken = runnerTokenFrom(vars.RUNNER_TOKEN);
  const bots = botSettingsFrom(vars);
  const githubWebhookSecret = vars.GITHUB_WEBHOOK_SECRET || undefined;
  const github = !!bots.githubAppId && !!bots.githubAppPrivateKey && !!githubWebhookSecret;
  if (!runnerToken || (!github && !bots.gitlabBotToken)) return {};
  return {
    // Nothing to wake: a runner asks for work on its own clock.
    // The App's id tells its own check suites from the repository's CI (src/notify/ci-hooks.ts).
    autoReview: {
      kick: () => {},
      remote: true as const,
      ...(bots.githubAppId ? { githubAppId: bots.githubAppId } : {}),
    },
    bots: botTokens(bots),
    runnerToken,
    ...(githubWebhookSecret ? { githubWebhookSecret } : {}),
  };
}
