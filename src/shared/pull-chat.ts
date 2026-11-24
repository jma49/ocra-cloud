import type { CodePlatformKind } from "./domain.js";
import type { ReviewChatMessageView, ReviewChatView } from "./review-chat.js";

// "Ask ocra" on a pull request's page: its conversation, each question with
// the finding or file it was asked about, and what a question sends. The
// answer streams as ReviewChatEvent does, its `done` carrying a
// PullChatMessageView.

export type PullChatMessageView = ReviewChatMessageView & {
  /** The finding the question was asked about, or null. */
  finding: string | null;
  /** The file the question was asked about, or null. */
  file: string | null;
};

export type PullChatView = Omit<ReviewChatView, "messages"> & {
  messages: PullChatMessageView[];
};

export type PullChatRequest = {
  platform: CodePlatformKind;
  repo: string;
  number: number;
  message: string;
  model?: string;
  /** One of the pull request's findings, by id. */
  finding?: string;
  /** A file of the pull request, by its path now. */
  file?: string;
};
