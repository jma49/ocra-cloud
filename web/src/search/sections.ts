import type { SearchPullResult, SearchResultsView } from "../../../src/shared/index.js";
import type { CommandEntry, CommandSection } from "../command-menu.js";

const pullRef = (p: SearchPullResult) =>
  `${p.repo}${p.platform === "gitlab" ? "!" : "#"}${p.number}`;

const pullEntry = (p: SearchPullResult, within: string): CommandEntry => ({
  label: p.title,
  hint: pullRef(p),
  to: p.to,
  within,
});

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The server's results as the menu's sections, the pull request a reference named first. */
export function resultSections(view: SearchResultsView): CommandSection[] {
  const jump = view.jump;
  const pulls = view.pulls
    .flatMap((p) => p.results)
    .filter((p) => !(jump && p.platform === jump.platform && p.id === jump.id));
  const sections: CommandSection[] = [
    { value: "Pull request", items: jump ? [pullEntry(jump, "Pull request")] : [] },
    { value: "Pull requests", items: pulls.map((p) => pullEntry(p, "Pull requests")) },
    {
      value: "Reviews",
      items: view.reviews.map((r) => ({
        label: `${r.repo ?? "Review"}${r.prNumber === null ? "" : `#${r.prNumber}`}`,
        hint: count(r.findings, "finding"),
        to: r.to,
        within: "Reviews",
      })),
    },
    {
      value: "Findings",
      items: (view.findings ?? []).map((f) => ({
        label: f.title,
        hint: f.line === null ? f.file : `${f.file}:${f.line}`,
        to: f.to,
        within: "Findings",
      })),
    },
    {
      value: "Repositories",
      items: view.repositories.map((r) => ({
        label: r.fullName,
        to: r.to,
        within: "Repositories",
      })),
    },
  ];
  return sections.filter((s) => s.items.length > 0);
}

const NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

/** The platforms that did not answer, whose pull requests the results lack. */
export function unanswered(view: SearchResultsView): string[] {
  return view.pulls.filter((p) => p.error).map((p) => NAMES[p.platform]);
}
