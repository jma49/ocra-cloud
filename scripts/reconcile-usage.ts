// Sets ocra Cloud's usage beside the provider's own, by UTC day and model,
// and prints where they differ (docs/usage-reconciliation.md). Run with Node:
// node scripts/reconcile-usage.ts --provider <console.csv> --ocra <ocra.csv>
//   [--api-key <name>] [--all]
// The provider's file is Anthropic's Console usage export for the month; the
// other is that month's CSV from ocra Cloud's Usage page. Exits 1 when they
// differ, 2 when a file cannot be read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { anthropicRates, type Rates } from "../src/model-prices.ts";

const KINDS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"] as const;
type Kind = (typeof KINDS)[number];
type Tokens = Record<Kind, number>;
/** Each UTC day's and model's tokens, keyed `day model`. */
type Usage = Map<string, Tokens>;

/** The rows of a CSV file, its header first; quoted fields may hold commas, quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** A header as compared: lower case, runs of anything else than letters and digits as one underscore. */
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** A model as compared: "Claude Sonnet 5.5" and "claude-sonnet-5-5" are one. */
const modelKey = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s._]+/g, "-");

// The names each column goes by: the Console's usage export, the Usage and
// Cost API's fields, and ocra Cloud's own CSV.
const COLUMNS = {
  day: ["usage_date_utc", "date", "day", "starting_at", "bucket_start_time"],
  model: ["model", "model_name"],
  apiKey: ["api_key", "api_key_name", "api_key_id", "key_name"],
  provider: ["provider"],
  input: [
    "usage_input_tokens_no_cache",
    "input_tokens_no_cache",
    "uncached_input_tokens",
    "input_tokens",
  ],
  cacheWrite5m: [
    "usage_input_tokens_cache_write_5m",
    "input_tokens_cache_write_5m",
    "ephemeral_5m_input_tokens",
    "cache_creation_ephemeral_5m_input_tokens",
    "cache_creation_input_tokens",
  ],
  cacheWrite1h: [
    "usage_input_tokens_cache_write_1h",
    "input_tokens_cache_write_1h",
    "ephemeral_1h_input_tokens",
    "cache_creation_ephemeral_1h_input_tokens",
  ],
  cacheRead: [
    "usage_input_tokens_cache_read",
    "input_tokens_cache_read",
    "cache_read_input_tokens",
  ],
  output: ["usage_output_tokens", "output_tokens"],
} as const;
const REQUIRED = ["day", "model", "input", "cacheRead", "output"] as const;

/** Which rows to keep: those whose column holds the value. */
type Only = { column: "apiKey" | "provider"; value: string };

/**
 * A usage CSV's tokens by day and model, whichever of the known names its
 * columns have, only the rows `only` names when it is given. Throws, naming
 * what is missing, when a needed column is not there.
 */
function readUsage(text: string, only?: Only): Usage {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("the file is empty");
  const names = header.map(norm);
  const at = Object.fromEntries(
    Object.entries(COLUMNS).map(([col, aliases]) => [
      col,
      aliases.map((a) => names.indexOf(a)).find((i) => i >= 0) ?? -1,
    ]),
  ) as Record<keyof typeof COLUMNS, number>;
  const missing = REQUIRED.filter((col) => at[col] < 0);
  if (only && at[only.column] < 0) missing.push(only.column as never);
  if (missing.length > 0) {
    throw new Error(
      `no column for ${missing.join(", ")} (it has ${header.join(", ")}); ` +
        `expected one of: ${missing.map((m) => COLUMNS[m].join(" | ")).join("; ")}`,
    );
  }
  const usage: Usage = new Map();
  for (const r of rows) {
    if (only && r[at[only.column]]?.trim() !== only.value) continue;
    const day = (r[at.day] ?? "").trim().slice(0, 10);
    const key = `${day} ${modelKey(r[at.model] ?? "")}`;
    const t = usage.get(key) ?? {
      input: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
    };
    for (const kind of KINDS) {
      const i = at[kind];
      t[kind] += i < 0 ? 0 : Number((r[i] ?? "").replaceAll(",", "")) || 0;
    }
    usage.set(key, t);
  }
  return usage;
}

/** What tokens cost at a model's list price, in dollars; null for a model without one. */
function costOf(model: string, t: Tokens, rates: Readonly<Record<string, Rates>> = anthropicRates) {
  const found = Object.hasOwn(rates, model) ? rates[model] : undefined;
  if (!found) return null;
  // A long prompt's rate applies per call, which a day's sum cannot tell: the short rate is used.
  const micro =
    t.input * found.input +
    t.cacheWrite5m * found.cacheWrite5m +
    t.cacheWrite1h * found.cacheWrite1h +
    t.cacheRead * found.cacheRead +
    t.output * found.output;
  return micro / 1_000_000;
}

type Difference = {
  day: string;
  model: string;
  provider: Tokens;
  ocra: Tokens;
  usd: number | null;
};

/** Every day and model of either file, oldest first, with the provider's tokens less ocra's priced. */
function reconcile(provider: Usage, ocra: Usage): Difference[] {
  const none: Tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  return [...new Set([...provider.keys(), ...ocra.keys()])].sort().map((key) => {
    const [day = "", model = ""] = key.split(" ");
    const p = provider.get(key) ?? none;
    const o = ocra.get(key) ?? none;
    const gap = Object.fromEntries(KINDS.map((k) => [k, p[k] - o[k]])) as Tokens;
    return { day, model, provider: p, ocra: o, usd: costOf(model, gap) };
  });
}

const differs = (d: Difference) => KINDS.some((k) => d.provider[k] !== d.ocra[k]);

function print(rows: Difference[], all: boolean): void {
  const shown = all ? rows : rows.filter(differs);
  const head = ["day", "model", ...KINDS.map((k) => `${k} (provider-ocra)`), "usd"];
  const lines = shown.map((d) => [
    d.day,
    d.model,
    ...KINDS.map((k) => `${d.provider[k]}-${d.ocra[k]}=${d.provider[k] - d.ocra[k]}`),
    d.usd === null ? "unpriced" : d.usd.toFixed(6),
  ]);
  for (const l of [head, ...lines]) console.log(l.join("\t"));
  const priced = shown.reduce((n, d) => n + (d.usd ?? 0), 0);
  console.log(
    `${rows.filter(differs).length} of ${rows.length} day and model rows differ; ` +
      `the provider counted $${priced.toFixed(2)} more than ocra Cloud at list prices.`,
  );
}

function main(): number {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      ocra: { type: "string" },
      "api-key": { type: "string" },
      all: { type: "boolean" },
    },
  });
  if (!values.provider || !values.ocra) {
    console.error(
      "usage: node scripts/reconcile-usage.ts --provider <console.csv> --ocra <ocra.csv> [--api-key <name>] [--all]",
    );
    return 2;
  }
  let rows: Difference[];
  try {
    const key = values["api-key"];
    const provider = readUsage(
      readFileSync(values.provider, "utf8"),
      key === undefined ? undefined : { column: "apiKey", value: key },
    );
    // Only Anthropic's calls are in its Console.
    const ocra = readUsage(readFileSync(values.ocra, "utf8"), {
      column: "provider",
      value: "anthropic",
    });
    rows = reconcile(provider, ocra);
  } catch (err) {
    console.error(`cannot reconcile: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  print(rows, values.all ?? false);
  return rows.some(differs) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
