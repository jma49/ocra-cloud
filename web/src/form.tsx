import { type ReactNode, useEffect, useState } from "react";

// Settings rows: a label, what it does, its built-in default, and a control.
// Unset means "the repository's value, else the default", shown as such.

export function Row(props: { label: string; desc: ReactNode; children: ReactNode }) {
  return (
    <div className="form-row">
      <div>
        <div className="label">{props.label}</div>
        <div className="desc">{props.desc}</div>
      </div>
      <div className="control">{props.children}</div>
    </div>
  );
}

export function NumberField(props: {
  value: number | undefined;
  placeholder: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  onChange: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(props.value === undefined ? "" : String(props.value));
  // Follow a value that changes from outside (the settings loading, Discard,
  // a restored version), but not one this field is in the middle of typing.
  useEffect(() => {
    const shown = text.trim() === "" ? undefined : Number(text);
    if (shown !== props.value) setText(props.value === undefined ? "" : String(props.value));
    // biome-ignore lint/correctness/useExhaustiveDependencies: only an outside change of the value resyncs
  }, [props.value]);
  const invalid =
    text !== "" &&
    (Number.isNaN(Number(text)) || Number(text) < props.min || Number(text) > props.max);
  return (
    <>
      <input
        className="input"
        inputMode="decimal"
        aria-label={props.label}
        aria-invalid={invalid}
        placeholder={props.placeholder}
        value={text}
        style={invalid ? { borderColor: "var(--critical)" } : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value === "") props.onChange(undefined);
          else if (!Number.isNaN(n) && n >= props.min && n <= props.max) props.onChange(n);
        }}
      />
      {props.unit && <span className="subtle small">{props.unit}</span>}
    </>
  );
}

/** On, off, or unset (the repository's choice, else the default). */
export function TriSwitch(props: {
  value: boolean | undefined;
  fallback: boolean;
  label: string;
  onChange: (v: boolean | undefined) => void;
}) {
  const on = props.value ?? props.fallback;
  return (
    <>
      {props.value === undefined ? (
        <span className="default-tag">default</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => props.onChange(undefined)}>
          Reset
        </button>
      )}
      <button
        type="button"
        role="switch"
        className="switch"
        aria-label={props.label}
        aria-checked={on}
        data-inherit={props.value === undefined}
        onClick={() => props.onChange(!on)}
      />
    </>
  );
}

/** A list of globs, added one at a time. */
export function GlobList(props: {
  value: string[];
  placeholder: string;
  label: string;
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const g = text.trim();
    if (!g || props.value.includes(g)) return;
    props.onChange([...props.value, g]);
    setText("");
  };
  return (
    <div style={{ display: "grid", gap: 8, width: "100%" }}>
      {props.value.length > 0 && (
        <div className="chips">
          {props.value.map((g) => (
            <span key={g} className="chip-x">
              {g}
              <button
                type="button"
                aria-label={`Remove ${g}`}
                onClick={() => props.onChange(props.value.filter((x) => x !== g))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input mono"
          style={{ flex: 1 }}
          aria-label={props.label}
          placeholder={props.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
