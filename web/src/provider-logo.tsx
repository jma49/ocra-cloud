import { providerMark } from "./provider-marks.js";

/**
 * A provider's own mark on a quiet tile, in its brand colours where it has
 * them and in ink where its mark is black; a name the gateway does not list
 * gets its first two letters.
 */
export function ProviderLogo(props: { name: string; label: string; size?: number }) {
  const size = props.size ?? 32;
  const mark = providerMark(props.name);
  const inner = size * 0.56;
  return (
    <span className="prov-logo" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {!mark ? (
        props.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)
      ) : "src" in mark ? (
        <img src={mark.src} width={inner} height={inner} alt="" draggable={false} />
      ) : (
        <svg
          width={inner}
          height={inner}
          viewBox="0 0 24 24"
          fill="currentColor"
          fillRule={mark.evenodd ? "evenodd" : undefined}
          aria-hidden="true"
          focusable="false"
        >
          {mark.d.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}
    </span>
  );
}
