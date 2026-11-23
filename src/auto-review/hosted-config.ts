import { configSchema, type OcraConfig } from "@open-cr-agent/cloud-contract";
import { errorName, logError } from "../log.js";
import type { CodePlatform } from "../platforms/platform.js";
import { MAX_REPO_CONFIG_BYTES, REPO_CONFIG_PATHS, textOf } from "../repo-config-file.js";
import { HOSTED_CONFIG_KEYS, HOSTED_REVIEWER_KEYS } from "../shared/index.js";

// What a hosted review takes from the repository's own .ocra/config.json.
// The run keeps --no-repo-config, so the CLI reads nothing from the clone:
// the server reads the file at the default branch's head of the enrolled
// repository (never the pull request's head, never a fork), checks it with
// the engine's schema, and passes on only settings that choose what is
// reviewed and how strictly, under its own. Nothing that names code to run,
// a model or endpoint, a runtime, a network address, a path to read, or
// whose comments to trust is taken.

type ReviewerEntry = OcraConfig["reviewers"][string];

export type HostedRepoConfig = Partial<
  Pick<
    OcraConfig,
    "include" | "exclude" | "verify" | "judge" | "showPreExisting" | "maxTasks" | "maxCostUsd"
  >
> & {
  reviewers?: Record<string, Pick<ReviewerEntry, (typeof HOSTED_REVIEWER_KEYS)[number]>>;
  github?: Pick<OcraConfig["github"], "requestChanges">;
};

/** The file's settings a hosted review applies; "invalid" when the engine would refuse the file. */
function hostedSubset(text: string): HostedRepoConfig | "invalid" {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "invalid";
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) return "invalid";
  // The parsed file has its defaults filled in: only what the file says is kept,
  // or an empty `exclude` would replace the account's.
  const said = new Set(Object.keys(raw as object));
  const value = parsed.data;
  const out: HostedRepoConfig = {};
  for (const key of HOSTED_CONFIG_KEYS) {
    if (!said.has(key)) continue;
    if (key === "reviewers") {
      const reviewers = Object.entries(value.reviewers)
        .map(([id, entry]) => [id, pick(entry, HOSTED_REVIEWER_KEYS)] as const)
        .filter(([, entry]) => Object.keys(entry).length > 0);
      if (reviewers.length > 0) out.reviewers = Object.fromEntries(reviewers);
    } else if (key === "github") {
      if (value.github.requestChanges !== undefined) {
        out.github = { requestChanges: value.github.requestChanges };
      }
    } else if (value[key] !== undefined) {
      (out as Record<string, unknown>)[key] = value[key];
    }
  }
  return out;
}

function pick<T extends object, K extends keyof T>(entry: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(
    keys.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]]),
  ) as Pick<T, K>;
}

/**
 * The repository's settings for a hosted review, read with the bot's token:
 * none when it has no file, and `ignored` when it has one the review cannot
 * use (unreadable, too large, not valid), which then runs without it.
 */
export async function readHostedConfig(
  platform: CodePlatform,
  token: string,
  fullName: string,
): Promise<{ config: HostedRepoConfig; ignored: boolean }> {
  const ignored = { config: {}, ignored: true };
  try {
    const head = await platform.contents.head(token, fullName);
    if (!head) return ignored;
    const path = REPO_CONFIG_PATHS.config;
    const [read] =
      (await platform.files.read(token, head, head.commit, [path], MAX_REPO_CONFIG_BYTES)) ?? [];
    if (!read || read.blobId === "") return ignored;
    if (read.blobId === null) return { config: {}, ignored: false };
    const text = read.bytes ? textOf(read.bytes) : undefined;
    const config = typeof text === "string" ? hostedSubset(text) : "invalid";
    return config === "invalid" ? ignored : { config, ignored: false };
  } catch (error) {
    logError("hosted_config_read_failed", { error: errorName(error) });
    return ignored;
  }
}

type ServerConfig = {
  reviewers?: Record<string, { enabled: false }>;
  showPreExisting?: boolean;
  github?: { botLogin: string };
  maxCostUsd?: number;
} & Record<string, unknown>;

/**
 * The run's configuration: the repository's settings under the server's,
 * which win key by key (a reviewer the profile turns off stays off, the bot
 * stays the one whose comments are trusted), and the lower spend limit.
 */
export function underServer(repo: HostedRepoConfig, server: ServerConfig): Record<string, unknown> {
  const reviewerIds = new Set([
    ...Object.keys(repo.reviewers ?? {}),
    ...Object.keys(server.reviewers ?? {}),
  ]);
  const reviewers = Object.fromEntries(
    [...reviewerIds].map((id) => [id, { ...repo.reviewers?.[id], ...server.reviewers?.[id] }]),
  );
  const github = { ...repo.github, ...server.github };
  const caps = [repo.maxCostUsd, server.maxCostUsd].filter((c) => c !== undefined);
  return {
    ...repo,
    ...server,
    ...(reviewerIds.size > 0 ? { reviewers } : {}),
    ...(Object.keys(github).length > 0 ? { github } : {}),
    ...(caps.length > 0 ? { maxCostUsd: Math.min(...caps) } : {}),
  };
}
