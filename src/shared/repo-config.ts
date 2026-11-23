import type { MAX_RULES_MARKDOWN_CHARS } from "@open-cr-agent/cloud-contract";
import type { CodePlatformKind } from "./domain.js";
import type { FileChangeOutcome } from "./learnings.js";

// A repository's committed review configuration, read live from its default
// branch as the signed-in user and changed by a commit of the user, checked
// first against the schema the engine reads the file with.

/**
 * `.ocra/config.json`, and the repository's rules: in plain language in
 * `.ocra/rules.md`, or as path and rule pairs in `.ocra/rules.json`.
 */
export const REPO_CONFIG_FILES = ["config", "rulesMarkdown", "rules"] as const;
export type RepoConfigFile = (typeof REPO_CONFIG_FILES)[number];

/** The contract's MAX_RULES_MARKDOWN_CHARS (the type holds it equal): longer, a review refuses the file. */
export const RULES_MARKDOWN_MAX_CHARS: typeof MAX_RULES_MARKDOWN_CHARS = 20_000;

/** Where the file's value does not fit the engine's schema: the JSON path, and why. */
export type RepoConfigIssue = { path: (string | number)[]; message: string };

export type RepoConfigView = {
  platform: CodePlatformKind;
  repo: string;
  branch: string;
  commit: string;
  file: RepoConfigFile;
  path: string;
  /** The file's git blob id; null when the default branch has no such file. A change names it. */
  blobId: string | null;
  /** null when there is no file, or it could not be read (`parseError` says why). */
  text: string | null;
  /** The parsed JSON; null when there is no file, it is not JSON, or it is the Markdown rules. */
  value: unknown;
  /** Why the file is not JSON, or could not be read; null when it parsed or is absent. */
  parseError: string | null;
  /** What the engine would refuse in it; [] when it fits, or did not parse. */
  errors: RepoConfigIssue[];
  /** True when there were more issues than `errors` lists. */
  moreErrors: boolean;
  /** The listed issues as the CLI words its refusal of the file; null when it fits, or did not parse. */
  refusal: string | null;
  /** The JSON Schema `$schema` may name, for editors; null for the rules files, which have none. */
  schema: string | null;
  lastCommit: { sha: string; at: string | null } | null;
};

export type RepoConfigChangeView = {
  outcome: FileChangeOutcome;
  path: string;
  /** The pull request the change was opened as; null when committed to the default branch, or not done. */
  pull: { number: number; url: string } | null;
};
