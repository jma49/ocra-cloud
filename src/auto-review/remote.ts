import { type BotSettings, botTokens } from "../platforms/bot-tokens.js";
import { githubHostOf } from "../platforms/registry.js";

// A host that runs no job itself (the Worker) still reviews pull requests
// when remote runners ask it for them (./runner-api.ts): it needs the
// GitHub App's key for the bot, the App's webhook secret for the queue, and
// the token its runners prove themselves with.

type Vars = {
  GITHUB_URL?: string | undefined;
  GITHUB_APP_ID?: string | undefined;
  GITHUB_APP_PRIVATE_KEY?: string | undefined;
  GITHUB_WEBHOOK_SECRET?: string | undefined;
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
export const botSettingsFrom = (vars: Vars & { GITLAB_BOT_TOKEN?: string | undefined }) =>
  ({
    githubApi: githubHostOf(vars.GITHUB_URL ? { GITHUB_URL: vars.GITHUB_URL } : {}).api,
    githubAppId: vars.GITHUB_APP_ID || undefined,
    githubAppPrivateKey: vars.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") || undefined,
    gitlabBotToken: vars.GITLAB_BOT_TOKEN || undefined,
  }) satisfies BotSettings;

/** What the app needs to queue jobs for remote runners; nothing unless every variable is set. */
export function remoteReviews(vars: Vars) {
  const runnerToken = runnerTokenFrom(vars.RUNNER_TOKEN);
  const bots = botSettingsFrom(vars);
  const githubWebhookSecret = vars.GITHUB_WEBHOOK_SECRET;
  if (!runnerToken || !bots.githubAppId || !bots.githubAppPrivateKey || !githubWebhookSecret) {
    return {};
  }
  return {
    // Nothing to wake: a runner asks for work on its own clock.
    // The App's id tells its own check suites from the repository's CI (src/notify/ci-hooks.ts).
    autoReview: { kick: () => {}, remote: true as const, githubAppId: bots.githubAppId },
    bots: botTokens(bots),
    runnerToken,
    githubWebhookSecret,
  };
}
