import type { CodePlatformKind } from "../shared/index.js";

// The ocra bot, as the API sees it: a credential for one repository, which
// only a self-hosted server has (src/node/bot-tokens.ts mints it).

export type BotCredential = {
  token: string;
  /** The login the bot posts as, which ocra trusts to have written its own summary. */
  login?: string;
};

export type BotTokens = {
  /** null when this deployment has no bot for the platform, or it was refused. */
  forRepo(platform: CodePlatformKind, fullName: string): Promise<BotCredential | null>;
};
