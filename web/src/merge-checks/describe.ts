import type { MergeCheckKind, MergeCheckView } from "../../../src/shared/index.js";

// A pre-merge check in words: its kind and what its settings ask.

export const KIND_LABEL: Record<MergeCheckKind, string> = {
  linked_issue: "Linked issue",
  title: "Title",
  description: "Description",
  size: "Size",
  critical_findings: "No critical findings",
  instruction: "Instruction",
};

export const KIND_HINT: Record<MergeCheckKind, string> = {
  linked_issue: "The pull request links an issue or task.",
  title: "The title starts with a prefix or matches a pattern.",
  description: "The description is not empty and has the headings named.",
  size: "The change stays under a number of files or lines.",
  critical_findings: "The latest review of its head found nothing critical.",
  instruction: "A rule in plain words, for ocra to judge. Not evaluated yet.",
};

export function settingsText(c: MergeCheckView): string {
  switch (c.kind) {
    case "linked_issue":
      return [
        c.settings.open ? "an open one" : "any",
        c.settings.label ? `labelled ${c.settings.label}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    case "title":
      return [
        c.settings.prefixes?.length ? `starts with ${c.settings.prefixes.join(" or ")}` : "",
        c.settings.glob ? `matches ${c.settings.glob}` : "",
      ]
        .filter(Boolean)
        .join(", or ");
    case "description":
      return c.settings.headings?.length
        ? `not empty, with ${c.settings.headings.join(", ")}`
        : "not empty";
    case "size":
      return [
        c.settings.maxFiles ? `at most ${c.settings.maxFiles} files` : "",
        c.settings.maxLines ? `at most ${c.settings.maxLines} lines` : "",
      ]
        .filter(Boolean)
        .join(", ");
    case "critical_findings":
      return "the latest review of the head";
    case "instruction":
      return c.settings.text;
  }
}
