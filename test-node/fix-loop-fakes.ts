import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "../src/node/checkout.js";
import { C1, C2 } from "./graph-fakes.js";

// What the fix loop's tests share: a round as `ocra mend --json` prints it
// and a machine that prints one.

export const STATE = { rounds: 1, costUsd: 0.02, items: { "fp-crit": { attempts: 1 } } };
export const EDIT = {
  path: "src/db.ts",
  startLine: 10,
  endLine: 10,
  replacement: "db.query(sql, [id]);",
};
export const item = (fingerprint: string, outcome: string, reason: string | null = null) => ({
  fingerprint,
  outcome,
  reason,
  edits: outcome === "fixed" ? [EDIT] : [],
});
export const round = (over: Record<string, unknown> = {}) => ({
  headSha: C1,
  outcome: "committed",
  stopped: null,
  commitSha: C2,
  items: [item("fp-crit", "fixed"), item("fp-warn", "rejected", "unresolved")],
  state: STATE,
  usage: {
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    costUsd: 0.02,
  },
  ...over,
});

type Seen = { args: string[]; findings?: { fingerprint: string }[]; state?: unknown };

/** The machine: git clones, the CLI prints `printed` and exits with code. */
export function fakeExec(printed: string, code = 0, during?: () => Promise<unknown>) {
  const seen: Seen = { args: [] };
  const exec: Exec = async (command, args, options) => {
    if (command === "git") {
      await mkdir(join(args.at(-1) ?? "", ".git"), { recursive: true });
      return { code: 0 };
    }
    seen.args = [...args];
    const file = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const findings = file("--findings");
    if (findings) seen.findings = JSON.parse(await readFile(findings, "utf8"));
    const state = file("--state");
    if (state) seen.state = JSON.parse(await readFile(state, "utf8"));
    await during?.();
    return { code, ...(options.stdout ? { stdout: printed } : {}) };
  };
  return { exec, seen };
}
