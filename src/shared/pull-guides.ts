import type { CodePlatformKind } from "./domain.js";

/** Lines `start` to `end` (1-based, inclusive) of a file's diff, on the side they are numbered by. */
export type PullDiffRange = {
  path: string;
  side: "old" | "new";
  start: number;
  end: number;
};

/** One stop of a pull request's tour: what changes there and why it matters. */
export type PullTourStop = {
  title: string;
  /** One to three sentences. */
  text: string;
  ranges: PullDiffRange[];
};

/** A guided walk through a pull request at one head, its stops in reading order. */
export type PullTourView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  /** The ocra-<provider>/<model> that wrote it, or null when nothing did. */
  model: string | null;
  stops: PullTourStop[];
};

/** A hunk a reviewer must read, with why in one line. */
export type PullHighlight = { range: PullDiffRange; reason: string };

/** The few hunks of a pull request at one head that need a reader; the rest is routine. */
export type PullHighlightsView = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  head: string;
  model: string | null;
  highlights: PullHighlight[];
};
