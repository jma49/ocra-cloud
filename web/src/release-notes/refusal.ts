/** Why the platform did not take a release, in the page's words. */
export const REFUSAL: Record<"target_missing" | "refused" | "unsupported", string> = {
  target_missing: "The target is not a branch or commit of this repository.",
  refused: "The platform refused: your account may not make releases in this repository.",
  unsupported: "This platform keeps no draft releases. Copy the Markdown into a release there.",
};
