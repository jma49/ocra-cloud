// How a list of requirements stands, in one thin line over it: a segment per
// state, as wide as its share.

export type TallyTone = "ok" | "err" | "warn" | "wait";

export function Tally(props: { parts: readonly { tone: TallyTone; n: number }[]; label: string }) {
  const shown = props.parts.filter((p) => p.n > 0);
  if (shown.length === 0) return null;
  return (
    <div className="tally" role="img" aria-label={props.label}>
      {shown.map((p) => (
        <span key={p.tone} className={`tally-part ${p.tone}`} style={{ flexGrow: p.n }} />
      ))}
    </div>
  );
}
