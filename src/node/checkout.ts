import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotCredential } from "../platforms/bot.js";
import type { CodePlatformKind } from "../shared/index.js";

// A hosted job's clone: the repository's default branch, fetched as the
// ocra bot into a directory of the job's own, with an environment that
// holds nothing of this machine but its network settings.

/** `stdout` only when asked for: what the command wrote, cut at MAX_STDOUT. */
type ExecResult = { code: number | null; stdout?: string };
/** Runs a command to its end; aborting the signal kills it with its children. */
export type Exec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal; stdout?: true },
) => Promise<ExecResult>;

/** What a command's output is read for is a line or two: an object id. */
const MAX_STDOUT = 4096;

type Repo = { platform: CodePlatformKind; url: string; fullName: string };

/**
 * Clones the repository into `checkout` as the bot and leaves its
 * credential in the clone's configuration: ocra fetches the pull request's
 * commits with the checkout's credentials, as in CI. Answers git's exit
 * code, 0 when it cloned.
 */
export async function cloneAsBot(
  exec: Exec,
  clone: { repo: Repo; bot: BotCredential; dir: string; home: string; checkout: string },
  signal: AbortSignal,
  flags: readonly string[] = [],
): Promise<number | null> {
  const { repo, checkout } = clone;
  const auth = gitAuth(repo.platform, clone.bot);
  const cloned = await exec(
    "git",
    ["clone", "--quiet", "--no-tags", ...flags, "--", repoUrl(repo.url, repo.fullName), checkout],
    { cwd: clone.dir, env: { ...baseEnv(clone.home), ...gitConfigEnv(repo.url, auth) }, signal },
  );
  if (cloned.code !== 0) return cloned.code;
  await appendFile(
    join(checkout, ".git", "config"),
    `[http "${repo.url}/"]\n\textraHeader = ${auth}\n`,
  );
  return 0;
}

const repoUrl = (url: string, fullName: string) =>
  `${url}/${fullName.split("/").map(encodeURIComponent).join("/")}.git`;

/** HTTP basic auth as each platform names a token's user. */
const gitAuth = (platform: Repo["platform"], bot: BotCredential) =>
  `Authorization: Basic ${Buffer.from(
    `${platform === "github" ? "x-access-token" : "oauth2"}:${bot.token}`,
  ).toString("base64")}`;

// Given in the environment, not the command line, where any process could read it.
const gitConfigEnv = (url: string, auth: string) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `http.${url}/.extraHeader`,
  GIT_CONFIG_VALUE_0: auth,
});

/**
 * How this host reaches the company's network, which git and the CLI need
 * too: its certificate authorities and its proxy.
 */
const NETWORK = [
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

const networkEnv = (): Record<string, string> =>
  Object.fromEntries(
    NETWORK.flatMap((name) => {
      const value = (process.env as Record<string, string | undefined>)[name];
      return value ? [[name, value]] : [];
    }),
  );

/** Only what git and the CLI need: no secret of this server reaches the child. */
export const baseEnv = (home: string): Record<string, string> => ({
  ...networkEnv(),
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C.UTF-8",
});

/** spawn in its own process group, so that an abort kills what it started too. */
export const spawnExec: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // The Worker's typing of process.env names its bindings; a child gets none of them.
      env: options.env as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", options.stdout ? "pipe" : "ignore", "ignore"],
      detached: true,
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_STDOUT) stdout = (stdout + chunk).slice(0, MAX_STDOUT);
    });
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    options.signal.addEventListener("abort", kill, { once: true });
    child.once("error", reject);
    // With its output read, it is done once that is all read too.
    child.once(options.stdout ? "close" : "exit", (code: number | null) => {
      options.signal.removeEventListener("abort", kill);
      resolve(options.stdout ? { code, stdout } : { code });
    });
  });
