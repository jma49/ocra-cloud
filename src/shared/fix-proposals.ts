import type { Severity } from "./domain.js";

// A finding's checked fix as the console shows it before it is committed:
// the lines it replaces as they are at the reviewed head, and what with.

export type FixProposalView = {
  finding: string;
  title: string;
  severity: Severity;
  file: string;
  startLine: number;
  endLine: number;
  /** null when the file at the reviewed head could not be read, or lacks those lines. */
  before: string[] | null;
  after: string[];
};

/** The lines a fix writes in place of its range, as a commit of it writes them. */
export function replacementLines(replacement: string): string[] {
  if (replacement === "") return [];
  return replacement.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

export type FixProposalsView = {
  /** The review the fixes come from; null when none reviewed the pull request at this head. */
  review: { id: string; head: string } | null;
  fixes: FixProposalView[];
};
