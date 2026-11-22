// A review's walkthrough of the change, as the review page shows it beside
// the findings: an overview, the files grouped by what they do, and an
// optional diagram (Mermaid text, drawn by the web).

export type ReviewWalkthroughView = {
  overview: string;
  groups: { title: string; files: string[]; note: string }[];
  diagram: string | null;
  redacted: boolean;
  truncated: boolean;
};
