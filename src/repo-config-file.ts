import { CONFIG_SCHEMA_ID, configSchema } from "@open-cr-agent/cloud-contract";
import { z } from "zod";
import { RULES_JSON_SCHEMA } from "./engine-schemas.js";
import type { RepoConfigFile, RepoConfigIssue } from "./shared/index.js";

// The files the engine reads a repository's review settings from, checked
// with the engine's own schemas: the configuration with the contract's
// configSchema, refinements included, and the rules with the JSON Schema of
// core's rule schema (src/engine-schemas.ts, generated: the contract has no
// rules schema, and the Worker does not load core). A refusal reads as the
// CLI words it (z.prettifyError).

export const REPO_CONFIG_PATHS: Record<RepoConfigFile, string> = {
  config: ".ocra/config.json",
  rules: ".ocra/rules.json",
};

/** Larger than any configuration a person writes by hand. */
export const MAX_REPO_CONFIG_BYTES = 64 * 1024;
const MAX_ISSUES = 20;
const MAX_MESSAGE = 300;
const MAX_REFUSAL = 4_000;

let rulesSchema: z.ZodType | undefined;

// The rules' is built on first use, not at import: the conversion walks the whole schema.
function schemaOf(file: RepoConfigFile): z.ZodType {
  if (file === "config") return configSchema;
  rulesSchema ??= z.fromJSONSchema(RULES_JSON_SCHEMA as z.core.JSONSchema.JSONSchema);
  return rulesSchema;
}

/** The $id of the file's JSON Schema; null for the rules file. */
export const schemaIdOf = (file: RepoConfigFile) => (file === "config" ? CONFIG_SCHEMA_ID : null);

type Checked =
  | { kind: "unparsed"; reason: string }
  | {
      kind: "parsed";
      value: unknown;
      errors: RepoConfigIssue[];
      more: boolean;
      refusal: string | null;
    };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const clip = (text: string, max = MAX_MESSAGE) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The file's text, or why it is not text the engine reads. */
export function textOf(bytes: Uint8Array): string | { reason: string } {
  if (bytes.byteLength > MAX_REPO_CONFIG_BYTES) {
    return { reason: `it is larger than ${MAX_REPO_CONFIG_BYTES} bytes` };
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return { reason: "it is not UTF-8 text" };
  }
}

/** The file parsed as the engine parses it (JSON.parse), and where it does not fit the schema. */
export function checkRepoConfig(file: RepoConfigFile, text: string): Checked {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "unparsed", reason: clip(`it is not valid JSON: ${(error as Error).message}`) };
  }
  let parsed: z.ZodSafeParseResult<unknown>;
  try {
    parsed = schemaOf(file).safeParse(value);
  } catch (error) {
    // The contract's endpoint refinement reads `new URL()` of a value that may not be one.
    const message = clip(`the engine could not check it: ${(error as Error).message}`);
    return {
      kind: "parsed",
      value,
      errors: [{ path: [], message }],
      more: false,
      refusal: message,
    };
  }
  const issues = parsed.success ? [] : parsed.error.issues;
  const listed = issues.slice(0, MAX_ISSUES);
  return {
    kind: "parsed",
    value,
    errors: listed.map((i) => ({
      path: i.path.filter((p): p is string | number => typeof p !== "symbol"),
      message: clip(i.message),
    })),
    more: issues.length > MAX_ISSUES,
    refusal: parsed.success ? null : clip(z.prettifyError(new z.ZodError(listed)), MAX_REFUSAL),
  };
}
