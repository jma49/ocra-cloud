import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { runRunner } from "./remote-runner.js";
import { installedCliVersion } from "./review-runner.js";

// A remote runner's entry: `node dist/runner.mjs`, kept running by the
// machine's service manager. docs/runner.md lists its variables.

const server = process.env.OCRA_CLOUD_URL;
const tokenFile = process.env.OCRA_RUNNER_TOKEN_FILE;
const token = (tokenFile ? readFileSync(tokenFile, "utf8") : process.env.OCRA_RUNNER_TOKEN)?.trim();
if (!server || !token) {
  throw new Error("set OCRA_CLOUD_URL, and OCRA_RUNNER_TOKEN_FILE or OCRA_RUNNER_TOKEN");
}
const poll = process.env.OCRA_RUNNER_POLL_SECONDS || "5";
if (!/^[1-9]\d*$/.test(poll)) {
  throw new Error(`OCRA_RUNNER_POLL_SECONDS must be a whole number above 0, not ${poll}`);
}

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());

const name = process.env.OCRA_RUNNER_NAME || hostname();
const version = installedCliVersion();
console.log(JSON.stringify({ level: "info", event: "runner_started", name, version, server }));
await runRunner(
  { server: new URL(server).origin, token, name, version, pollMs: Number(poll) * 1000 },
  stop.signal,
);
console.log(JSON.stringify({ level: "info", event: "runner_stopped", name }));
