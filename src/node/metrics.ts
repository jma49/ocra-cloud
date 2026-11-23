import { sameText, sha256Hex } from "../crypto.js";
import type { Db } from "../db/client.js";
import { SCHEMA_TAG } from "../db/migrations.js";
import { COLLECTORS, OPS_METRICS } from "../db/ops-metrics.js";
import { errorName, logError } from "../log.js";

// GET /metrics on the self-hosted server, in Prometheus' text format, for
// those who run it: off unless METRICS_TOKEN is set, and then only with
// that token as a bearer. Aggregates only (../db/ops-metrics.ts), and the
// process's own uptime and versions.

export type MetricsOptions = { token: string; engineVersion: string; startedAt: number };

const PROCESS_METRICS = {
  ocra_process_uptime_seconds: { help: "Seconds since this process started.", labels: [] },
  ocra_build_info: {
    help: "Always 1: the engine version and the newest migration this build expects.",
    labels: ["engine", "schema"],
  },
  ocra_metrics_collector_up: {
    help: "Whether a collector read the database on this scrape.",
    labels: ["collector"],
  },
} as const;

/** Every metric /metrics may answer, with the only labels each carries. */
export const METRICS = { ...OPS_METRICS, ...PROCESS_METRICS };

type Line = { metric: keyof typeof METRICS; labels: Record<string, string>; value: number };

export function metricsEndpoint(db: Db, options: MetricsOptions) {
  const expected = sha256Hex(options.token);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    const given = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
    if (!sameText(await sha256Hex(given), await expected)) {
      return new Response("unauthenticated\n", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="metrics"' },
      });
    }
    const now = new Date();
    const lines: Line[] = [
      {
        metric: "ocra_process_uptime_seconds",
        labels: {},
        value: (now.getTime() - options.startedAt) / 1000,
      },
      {
        metric: "ocra_build_info",
        labels: { engine: options.engineVersion, schema: SCHEMA_TAG },
        value: 1,
      },
    ];
    const collectors = Object.entries(COLLECTORS);
    const results = await Promise.allSettled(collectors.map(([, collect]) => collect(db, now)));
    results.forEach((result, i) => {
      const collector = collectors[i]?.[0] ?? "";
      if (result.status === "fulfilled") lines.push(...result.value);
      else logError("metrics_collect_failed", { collector, error: errorName(result.reason) });
      const up = result.status === "fulfilled" ? 1 : 0;
      lines.push({ metric: "ocra_metrics_collector_up", labels: { collector }, value: up });
    });
    return new Response(render(lines), {
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
}

/** The text exposition format: each metric's HELP and TYPE once, then its series. */
function render(lines: Line[]): string {
  const out: string[] = [];
  for (const [metric, { help }] of Object.entries(METRICS)) {
    const series = lines.filter((l) => l.metric === metric);
    if (series.length === 0) continue;
    out.push(`# HELP ${metric} ${help}`, `# TYPE ${metric} gauge`);
    for (const { labels, value } of series) out.push(`${metric}${labelText(labels)} ${value}`);
  }
  return `${out.join("\n")}\n`;
}

function labelText(labels: Record<string, string>): string {
  const pairs = Object.entries(labels).map(
    ([name, value]) =>
      `${name}="${value.replace(/[\\"\n]/g, (ch) => (ch === "\n" ? "\\n" : `\\${ch}`))}"`,
  );
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}
