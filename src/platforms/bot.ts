import type { CodePlatformKind } from "../shared/index.js";

// The ocra bot, as the API sees it: a credential for one repository, which
// only a self-hosted server has (src/node/bot-tokens.ts mints it).

export type BotCredential = {
  token: string;
  /** The login the bot posts as, which ocra trusts to have written its own summary. */
  login?: string;
};

/** What the bot's token may do: comment on pull requests, or also push to their branches. */
export type BotAccess = "review" | "commit";

export type BotTokens = {
  /** null when this deployment has no bot for the platform, or it was refused. */
  forRepo(
    platform: CodePlatformKind,
    fullName: string,
    access?: BotAccess,
  ): Promise<BotCredential | null>;
};
