import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chown, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// A real Postgres server for what PGlite cannot show: behind its wire
// protocol PGlite is one backend, so a NOTIFY reaches the connection that
// sent it, not the one that LISTENs. The server's own binaries (on PATH, or
// Debian's and Ubuntu's /usr/lib/postgresql/<version>/bin, which GitHub's
// runners have) start a cluster in a temporary directory, on a Unix socket
// only. Without them the tests skip, except on CI, where they must run.

const run = promisify(execFile);

function binDir(): string | undefined {
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .find((d) => existsSync(join(d, "initdb")));
  if (onPath) return onPath;
  const root = "/usr/lib/postgresql";
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a));
  return versions.map((v) => join(root, v, "bin")).find((d) => existsSync(join(d, "initdb")));
}

/** Whether a server can start here; on CI it must. */
export function realPostgresAvailable(): boolean {
  const found = binDir() !== undefined;
  if (!found && process.env.CI) throw new Error("CI has no Postgres server binaries");
  return found;
}

export type RealPostgres = { url: string; stop(): Promise<void> };

export async function startRealPostgres(): Promise<RealPostgres> {
  const bin = binDir();
  if (!bin) throw new Error("no Postgres server binaries");
  const dir = await mkdtemp(join(tmpdir(), "ocra-pg-"));
  const data = join(dir, "data");
  // initdb refuses root: a container run as root runs the server as postgres.
  const asRoot = process.getuid?.() === 0;
  if (asRoot) {
    const uid = Number((await run("id", ["-u", "postgres"])).stdout.trim());
    const gid = Number((await run("id", ["-g", "postgres"])).stdout.trim());
    await chown(dir, uid, gid);
  }
  const pgRun = (tool: string, args: string[]) =>
    asRoot
      ? run("runuser", ["-u", "postgres", "--", join(bin, tool), ...args])
      : run(join(bin, tool), args);
  await pgRun("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-N", "-E", "UTF8"]);
  const settings = `-c listen_addresses= -c unix_socket_directories=${dir} -c fsync=off`;
  await pgRun("pg_ctl", ["-D", data, "-w", "-l", join(dir, "log"), "-o", settings, "start"]);
  return {
    url: `postgres://postgres@localhost/postgres?host=${encodeURIComponent(dir)}`,
    async stop() {
      await pgRun("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}
