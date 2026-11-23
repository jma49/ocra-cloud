// What a pull request's page reads as it opens, so a navigation starts them
// together instead of in two waves behind the page's code and its files.
// The files come first: a hover starts only them.
const FIRST = ["files", "since", "queue", "description-draft"] as const;
const BOXES = ["stack", "checks", "threads", "labels", "people", "reviewers", "readiness"] as const;

export function pullReads(ref: { platform: string; repo: string; number: string }): string[] {
  const query = new URLSearchParams(ref).toString();
  return [...FIRST, ...BOXES].map((read) => `/pulls/${read}?${query}`);
}
