import { describe, expect, it } from "vitest";
import { spawnExec } from "../src/node/checkout.js";
import { runDetail } from "../src/node/run-detail.js";

// Why a hosted run failed: the end of what the CLI wrote to stderr, kept
// short and redacted, read only when the runner asks for it.

const node = (script: string, stderr?: true) =>
  spawnExec(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    signal: AbortSignal.timeout(10_000),
    ...(stderr ? { stderr } : {}),
  });

describe("a command's stderr", () => {
  it("is read only when asked for, and then only its end", async () => {
    const script = `process.stderr.write("a".repeat(10000) + "\\nlast line\\n"); process.exit(4)`;
    expect(await node(script)).toEqual({ code: 4 });
    const ran = await node(script, true);
    expect(ran.code).toBe(4);
    expect(ran.stderr?.length).toBe(4096);
    expect(ran.stderr?.endsWith("last line\n")).toBe(true);
  });
});

describe("a run's detail", () => {
  it("keeps the last three lines, without terminal escapes, each cut, with keys redacted", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const stderr = `first\n\n\x1b[33mwarning\x1b[0m: slow\n${"y".repeat(300)}\nfailed with ${key}\r\n`;
    const detail = runDetail(stderr);
    expect(detail).toBe(`warning: slow\n${"y".repeat(200)}\nfailed with [redacted]`);
    expect(detail).not.toContain(key);
  });

  it("is null for a run that wrote nothing but blank lines", () => {
    expect(runDetail(undefined)).toBeNull();
    expect(runDetail("\n  \n")).toBeNull();
  });
});
