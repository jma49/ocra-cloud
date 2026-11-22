import type { FindingIssueRequest } from "../shared/index.js";

// Opening an issue in a repository as the signed-in user: the platform
// checks their permission, and its refusal is answered as one.

export interface RepoIssues {
  /** The new issue's number; `refused` for a 4xx but 429, null when the platform was not reached. */
  open(
    token: string,
    fullName: string,
    issue: FindingIssueRequest,
  ): Promise<{ number: number } | "refused" | null>;
  /** The issue's page on the platform. */
  pageUrl(fullName: string, number: number): string;
}

/** What a create answered, by the number at `key`: a positive integer, or not reached. */
export function openedIssue(
  sent: { status: number; body: Record<string, unknown> | null } | null,
  key: "number" | "iid",
): { number: number } | "refused" | null {
  if (!sent) return null;
  if (sent.status >= 400 && sent.status < 500 && sent.status !== 429) return "refused";
  if (sent.status < 200 || sent.status >= 300) return null;
  const number = sent.body?.[key];
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0
    ? { number }
    : null;
}
