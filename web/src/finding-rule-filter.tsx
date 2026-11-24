import type { FindingRule } from "../../src/shared/index.js";

// The findings inbox's filter by the rule or learning a finding names.

type Named = NonNullable<FindingRule>;

/** How a finding's rule reads in its row. */
export const ruleName = (r: Named) => `${r.kind} ${r.id}`;

/**
 * A select of the rules the listed findings name, keyed `<kind>:<id>` as the
 * API filters by, or "none" for the findings that named none.
 */
export function RuleFilter(props: {
  value: string;
  rules: readonly FindingRule[];
  onChange: (rule: string) => void;
}) {
  const options = new Map(
    props.rules.flatMap((r) => (r ? [[`${r.kind}:${r.id}`, ruleName(r)] as const] : [])),
  );
  return (
    <label>
      Rule{" "}
      <select
        className="input"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">Any</option>
        <option value="none">No rule named</option>
        {[...options].map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
