import {
  type LearningFrontmatter,
  learningFrontmatterSchema,
  MAX_LEARNING_BODY,
  MAX_LEARNING_BYTES,
  splitLearning,
} from "@open-cr-agent/cloud-contract";
import { parse, stringify } from "yaml";

// The contract splits a learning file and checks its frontmatter but leaves
// the YAML to the caller. These follow the engine's parseLearning and
// learningFile (ADR-0037), so what the console writes is what a review reads.

export type ParsedLearning = { frontmatter: LearningFrontmatter; body: string };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The learning, or why the file is not one. */
export function parseLearning(bytes: Uint8Array): ParsedLearning | string {
  if (bytes.byteLength > MAX_LEARNING_BYTES) return `it is larger than ${MAX_LEARNING_BYTES} bytes`;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return "it is not UTF-8 text";
  }
  const split = splitLearning(text);
  if (!split) return "it does not open with a --- frontmatter block";
  if (split.body.length === 0) return "its body is empty";
  if (split.body.length > MAX_LEARNING_BODY) {
    return `its body is longer than ${MAX_LEARNING_BODY} characters`;
  }
  let data: unknown;
  try {
    data = parse(split.frontmatter, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  } catch {
    return "its frontmatter is not valid YAML";
  }
  const frontmatter = learningFrontmatterSchema.safeParse(data);
  if (!frontmatter.success) {
    const first = frontmatter.error.issues[0];
    return `its frontmatter is invalid: ${first?.path.join(".") || "frontmatter"}: ${first?.message ?? "invalid"}`;
  }
  return { frontmatter: frontmatter.data, body: split.body };
}

/** The learning as a file, or why it would not read back as one. */
export function learningFile(learning: ParsedLearning): Uint8Array | string {
  const f = learning.frontmatter;
  const frontmatter = {
    title: f.title,
    paths: f.paths,
    ...(f.symbols.length > 0 ? { symbols: f.symbols } : {}),
    ...(f.keywords.length > 0 ? { keywords: f.keywords } : {}),
    ...(f.critical ? { critical: true } : {}),
    ...(f.source
      ? { source: { kind: f.source.kind, ...(f.source.ref ? { ref: f.source.ref } : {}) } }
      : {}),
    created: f.created,
  };
  const text = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${learning.body.trim()}\n`;
  const bytes = new TextEncoder().encode(text);
  const back = parseLearning(bytes);
  return typeof back === "string" ? back : bytes;
}
