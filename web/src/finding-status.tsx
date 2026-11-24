import { Status, type StatusTone } from "@/components/status";
import type { FindingStatus } from "../../src/shared/index.js";

/** A finding's standing, in the words every page uses for it. */
export const FINDING_STATUS_NAME: Record<FindingStatus, string> = {
  open: "Open",
  fixed: "Fixed",
  dismissed: "Dismissed",
  addressed: "Addressed",
  merged: "Merged unaddressed",
};

// Merged with nothing done about it is the one standing that asks for a look.
const TONE: Record<FindingStatus, StatusTone> = {
  open: "run",
  fixed: "ok",
  dismissed: "quiet",
  addressed: "quiet",
  merged: "warn",
};

export function FindingStanding(props: { status: FindingStatus }) {
  return <Status tone={TONE[props.status]}>{FINDING_STATUS_NAME[props.status]}</Status>;
}
