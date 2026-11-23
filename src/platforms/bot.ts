import type { CodePlatformKind } from "../shared/index.js";

// The ocra bot, as the API sees it: a credential for one repository, which
// a host with the App's key mints (./bot-tokens.ts).

export type BotCredential = {
  token: string;
  /** The login the bot posts as, which ocra trusts to have written its own summary. */
  login?: string;
};

/**
 * The repository a credential is for. An enrolled GitLab project may bring
 * its own access token, sealed (./repo-token.ts), which wins over the
 * deployment's bot.
 */
export type BotRepo = {
  platform: CodePlatformKind;
  fullName: string;
  id?: string;
  accountId?: string;
  accessTokenWrappedKey?: string | null;
  accessTokenCiphertext?: string | null;
};

/** What the bot's token may do: comment on pull requests, or also push to their branches. */
export type BotAccess = "review" | "commit";

export type BotTokens = {
  /** null when this deployment has no bot for the platform, or it was refused. */
  forRepo(repo: BotRepo, access?: BotAccess): Promise<BotCredential | null>;
  /**
   * Whether `login` is a member of the GitHub organisation, read with the
   * App's Members permission there; null when the App cannot tell.
   */
  orgMember?(org: string, login: string): Promise<boolean | null>;
  /**
   * The platform ids of the members of the organisation's team (by its
   * slug), read with the App's Members permission there, at most one page;
   * null when the App cannot tell. Never throws.
   */
  teamMembers?(org: string, slug: string): Promise<string[] | null>;
};
