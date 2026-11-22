import { z } from "zod";
import { CONFIG_JSON_SCHEMA, CONFIG_SCHEMA_ID, RULES_JSON_SCHEMA } from "./engine-schemas.js";
import type { RepoConfigFile, RepoConfigIssue } from "./shared/index.js";

// The files the engine reads a repository's review settings from, checked
// with the JSON Schemas of the engine's own schemas (src/engine-schemas.ts,
// generated from the engine's packages). The configuration's lacks the
// refinements the CLI checks again when it loads the file (endpoint and
// credential-name rules, unique merge check ids), so a file that passes here
// can still be refused by a review; one refused here, the engine refuses too.

export const REPO_CONFIG_PATHS: Record<RepoConfigFile, string> = {
  config: ".ocra/config.json",
  rules: ".ocra/rules.json",
};

/** Larger than any configuration a person writes by hand. */
export const MAX_REPO_CONFIG_BYTES = 64 * 1024;
const MAX_ISSUES = 20;
const MAX_MESSAGE = 300;

const JSON_SCHEMAS = { config: CONFIG_JSON_SCHEMA, rules: RULES_JSON_SCHEMA };
const schemas: Partial<Record<RepoConfigFile, z.ZodType>> = {};

// Built on first use, not at import: the conversion walks the whole schema.
function schemaOf(file: RepoConfigFile): z.ZodType {
  schemas[file] ??= z.fromJSONSchema(JSON_SCHEMAS[file] as z.core.JSONSchema.JSONSchema);
  return schemas[file];
}

/** The $id of the file's JSON Schema; null for the rules file. */
export const schemaIdOf = (file: RepoConfigFile) => (file === "config" ? CONFIG_SCHEMA_ID : null);

type Checked =
  | { kind: "unparsed"; reason: string }
  | { kind: "parsed"; value: unknown; errors: RepoConfigIssue[]; more: boolean };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const clip = (text: string) =>
  text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;

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
  const parsed = schemaOf(file).safeParse(value);
  const issues = parsed.success ? [] : parsed.error.issues;
  return {
    kind: "parsed",
    value,
    errors: issues.slice(0, MAX_ISSUES).map((i) => ({
      path: i.path.filter((p): p is string | number => typeof p !== "symbol"),
      message: clip(i.message),
    })),
    more: issues.length > MAX_ISSUES,
  };
}
