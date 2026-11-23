import type { PageCommand } from "../page-commands.js";
import { navigate } from "../router.js";

/** What a review's page does from the keyboard and the command menu. */
export function reviewCommands(review: {
  findings: number;
  move: (step: 1 | -1) => void;
  toggleDetails: () => void;
  /** The console's page of the pull request it reviewed. */
  pull: string | null;
}): PageCommand[] {
  const { pull } = review;
  return [
    ...(review.findings > 0
      ? [
          { label: "Next finding", key: "j", run: () => review.move(1) },
          { label: "Previous finding", key: "k", run: () => review.move(-1) },
          { label: "Show or hide details", key: "d", run: review.toggleDetails },
        ]
      : []),
    ...(pull ? [{ label: "Open the pull request", key: "p", run: () => navigate(pull) }] : []),
  ];
}
