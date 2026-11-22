import type { CodePlatformKind } from "../../../src/shared/index.js";

/** A pull request's page in the console; the repository's slashes travel encoded in one segment. */
export const pullPath = (platform: CodePlatformKind, repo: string, number: number) =>
  `/pull/${platform}/${encodeURIComponent(repo)}/${number}`;
