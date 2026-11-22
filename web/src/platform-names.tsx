import type { CodePlatformKind } from "../../src/shared/index.js";

// The code platforms by name, limited to those this deployment offers (`Me.platforms`).

export const PLATFORM_NAME: Record<CodePlatformKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

/** The platforms as a sentence names them: "GitHub", "GitHub or GitLab". */
export function platformsText(kinds: readonly CodePlatformKind[]): string {
  const names = [...new Set(kinds)].map((k) => PLATFORM_NAME[k]);
  return names.length > 0 ? names.join(" or ") : "a code platform";
}

/** A choice of platform; none where the deployment offers only one, which is then the value. */
export function PlatformSelect(props: {
  platforms: readonly CodePlatformKind[];
  value: CodePlatformKind;
  onChange: (p: CodePlatformKind) => void;
}) {
  if (props.platforms.length < 2) return null;
  return (
    <select
      className="input"
      aria-label="Platform"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as CodePlatformKind)}
    >
      {props.platforms.map((p) => (
        <option key={p} value={p}>
          {PLATFORM_NAME[p]}
        </option>
      ))}
    </select>
  );
}
