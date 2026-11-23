import { Switch } from "@/components/ui/switch";
import { LIMIT_OFF } from "../../../src/shared/index.js";

// One of the account's limits as it is being edited: on with a number of
// its own, on with the default (left empty), or off.

export type LimitDraft = { on: boolean; text: string };

/** The draft of a saved limit: null is the default's, LIMIT_OFF none. */
export const draftOf = (own: number | null): LimitDraft =>
  own === LIMIT_OFF ? { on: false, text: "" } : { on: true, text: own === null ? "" : String(own) };

/**
 * The limit to save: LIMIT_OFF when off, null for the default, else the
 * number read from the text; undefined when the text is not a limit.
 */
export function savedOf(
  draft: LimitDraft,
  read: (text: string) => number | undefined,
): number | null | undefined {
  if (!draft.on) return LIMIT_OFF;
  return draft.text.trim() === "" ? null : read(draft.text);
}

export function LimitField(props: {
  label: string;
  /** The default, as the placeholder names it. */
  fallback: string;
  draft: LimitDraft;
  onChange: (draft: LimitDraft) => void;
}) {
  const { draft, onChange } = props;
  return (
    <div className="limit-field">
      <label className="row-gap center">
        <span className="nobreak">{props.label}</span>
        <input
          className="input"
          inputMode="decimal"
          disabled={!draft.on}
          placeholder={draft.on ? `${props.fallback} by default` : "No limit"}
          value={draft.on ? draft.text : ""}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </label>
      <span className="row-gap center">
        <Switch
          aria-label={`${props.label} on`}
          checked={draft.on}
          onCheckedChange={(on) => onChange({ ...draft, on })}
        />
        <span className="subtle small">{draft.on ? "On" : "Off"}</span>
      </span>
    </div>
  );
}
