import { providerMark } from "./provider-marks.js";

/**
 * A provider's own mark on a quiet tile, in ink rather than its brand
 * colour so every tile reads the same in both themes; a name the gateway
 * does not list gets its first two letters.
 */
export function ProviderLogo(props: { name: string; label: string; size?: number }) {
  const size = props.size ?? 32;
  const mark = providerMark(props.name);
  return (
    <span className="prov-logo" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {mark ? (
        <svg
          width={size * 0.56}
          height={size * 0.56}
          viewBox="0 0 24 24"
          fill="currentColor"
          fillRule={mark.evenodd ? "evenodd" : undefined}
          aria-hidden="true"
          focusable="false"
        >
          {mark.d.map((d, i) => (
            <path key={d} d={d} fillOpacity={mark.faint?.includes(i) ? 0.5 : undefined} />
          ))}
        </svg>
      ) : (
        props.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)
      )}
    </span>
  );
}
