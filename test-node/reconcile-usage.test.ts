import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/reconcile-usage.ts run as the maintainer runs it, on a Console
// usage export as its columns are named and ocra Cloud's CSV of the same days.

const CONSOLE = [
  "usage_date_utc,model,workspace,api_key,usage_type,usage_input_tokens_no_cache," +
    "usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h," +
    "usage_input_tokens_cache_read,usage_output_tokens",
  "2026-11-23,claude-sonnet-5-5,Default,ocra-cloud,standard,1000,200,0,5000,300",
  "2026-11-23,claude-sonnet-5-5,Default,ocra-cloud,standard,500,0,0,0,100",
  "2026-11-23,claude-sonnet-5-5,Default,eval-ci,standard,90000,0,0,0,9000",
  '2026-11-24,"Claude Haiku 5.5","Default, ""main""",ocra-cloud,standard,"1,000",0,0,0,10',
].join("\n");
const OCRA = [
  "usage_date_utc,provider,model,calls,failed_calls,input_tokens_no_cache," +
    "input_tokens_cache_write_5m,input_tokens_cache_write_1h,input_tokens_cache_read," +
    "output_tokens,cost_usd,unpriced_calls",
  "2026-11-23,anthropic,claude-sonnet-5-5,2,0,1500,200,0,5000,400,0.006000,0",
  "2026-11-24,anthropic,claude-haiku-5-5,1,0,400,0,0,0,10,0.000045,0",
  "2026-11-24,openrouter,vendor/other,1,0,7,0,0,0,1,0.000000,1",
].join("\r\n");

function files(provider: string, ocra = OCRA) {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  writeFileSync(join(dir, "console.csv"), provider);
  writeFileSync(join(dir, "ocra.csv"), ocra);
  return { provider: join(dir, "console.csv"), ocra: join(dir, "ocra.csv") };
}

function run(...args: string[]): { code: number; out: string } {
  const script = new URL("../scripts/reconcile-usage.ts", import.meta.url).pathname;
  try {
    return { code: 0, out: execFileSync("node", [script, ...args], { encoding: "utf8" }) };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout + e.stderr };
  }
}

describe("reconciling usage", () => {
  it("prints the days and models that differ for one API key, and exits 1", () => {
    const f = files(CONSOLE);
    const { code, out } = run(
      "--provider",
      f.provider,
      "--ocra",
      f.ocra,
      "--api-key",
      "ocra-cloud",
    );
    expect(code).toBe(1);
    // 600 more uncached input tokens at Haiku 5.5's $0.10 a million.
    expect(out).toContain("2026-11-24\tclaude-haiku-5-5\t1000-400=600\t");
    expect(out).toContain("\t0.000060\n");
    expect(out).not.toContain("claude-sonnet-5-5");
    expect(out).not.toContain("vendor/other");
    expect(out).toContain("1 of 2 day and model rows differ");
  });

  it("exits 0 when they agree", () => {
    const agree = CONSOLE.split("\n").slice(0, 3).join("\n");
    const f = files(agree, OCRA.split("\r\n").slice(0, 2).join("\r\n"));
    const { code, out } = run("--provider", f.provider, "--ocra", f.ocra);
    expect(code).toBe(0);
    expect(out).toContain("0 of 1 day and model rows differ");
  });

  it("names the columns it could not find, and exits 2", () => {
    const f = files("date,model,tokens\n2026-11-23,m,1");
    const { code, out } = run("--provider", f.provider, "--ocra", f.ocra);
    expect(code).toBe(2);
    expect(out).toContain("no column for input, cacheRead, output");
    expect(run("--provider", f.provider).code).toBe(2);
  });
});
