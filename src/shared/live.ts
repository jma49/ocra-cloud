import type { ReviewEvent, ReviewSource } from "@open-cr-agent/cloud-contract";

// A review watched while it runs (ADR-0056), and who it is shared with.

export const LIVE_STATES = ["running", "finished", "failed"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

/** What a person the owner shares a run with may do: watch it, or also comment. */
export const LIVE_ROLES = ["watch", "comment"] as const;
export type LiveRole = (typeof LIVE_ROLES)[number];
export type LiveAccess = "owner" | LiveRole;

/** A stored event as the API answers it: the contract's, without the envelope's version and run. */
export type LiveEventView = ReviewEvent extends infer E
  ? E extends { kind: infer K; data: infer D; seq: number; at: string }
    ? { kind: K; data: D; seq: number; at: string }
    : never
  : never;

export type LiveRunView = {
  id: string;
  runId: string;
  owner: string;
  access: LiveAccess;
  target: string;
  source: ReviewSource;
  /** The repository's name as the account knows it, or the pull request's path. */
  repo: string | null;
  prNumber: number | null;
  state: LiveState;
  verdict: string | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
};

export type LiveCommentView = {
  id: string;
  author: string;
  findingId: string | null;
  body: string;
  createdAt: string;
  /** The viewer wrote it, or owns the run: they may remove it. */
  removable: boolean;
};

export type LiveShareView = {
  /** The run's link while it is on, for anyone signed in to this server who has it. */
  link: { role: LiveRole; url: string } | null;
  people: { id: string; login: string; role: LiveRole }[];
};

/** Characters of one comment. */
export const MAX_LIVE_COMMENT = 4_000;
/** People one run is shared with. */
export const MAX_LIVE_PEOPLE = 50;
