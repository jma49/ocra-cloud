// A ranked list of horizontal bars, each with its name and its value in
// words: for shares and rates across a few categories, where a pie would
// make the reader compare angles.

export type BarRow = { key: string; label: string; value: number; text: string };

export function BarList(props: {
  /** What the list shows, as its accessible name. */
  label: string;
  rows: BarRow[];
  /** The value a full bar stands for (100 for a percentage); the largest row by default. */
  max?: number;
  color?: string;
}) {
  const max = props.max ?? Math.max(1, ...props.rows.map((r) => r.value));
  return (
    <ul className="bar-list" aria-label={props.label}>
      {props.rows.map((r) => (
        <li key={r.key}>
          <span className="bar-list-name">{r.label}</span>
          <span className="bar-list-track" aria-hidden="true">
            <span
              style={{
                width: `${Math.max(0, Math.min(100, (r.value / max) * 100))}%`,
                background: props.color ?? "var(--c1)",
              }}
            />
          </span>
          <span className="bar-list-value">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
