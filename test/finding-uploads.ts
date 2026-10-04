// Uploads with shared findings, for the tests of findings and of memory.

/** A repository id, as the CLI hashes it. */
export const HASH = "b".repeat(64);

/** A shared finding as the CLI uploads it. */
export const finding = (over: Record<string, unknown> = {}) => ({
  fingerprint: "fp-1234",
  reviewer: "security",
  severity: "critical",
  category: "injection",
  verification: "confirmed",
  file: "src/db.ts",
  lineStart: 10,
  lineEnd: 12,
  title: "SQL built from input",
  body: "The query concatenates user input.",
  suggestion: "Use a parameter.",
  code: 'db.query("SELECT * FROM t WHERE id=" + id)',
  ...over,
});
/** An upload of one run with its shared findings. */
export const upload = (runId: string, findingList: unknown[]) => ({
  runId,
  repoHash: HASH,
  source: "local",
  findings: { critical: 1, warning: 0, suggestion: 0 },
  findingList,
});
