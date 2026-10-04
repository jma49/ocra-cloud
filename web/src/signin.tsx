import { SpiderMark } from "./spider.js";
import "./signin.css";

// The signed-out screen, in the landing page's look (ocra-site DESIGN.md):
// an ink night with two halftone screens off register, an orb web in the
// corner, the spider, a poster headline and a frosted card with the one
// action. The web is a fixed drawing here; the site generates its own.

const GITHUB_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

const POINTS: [string, string][] = [
  [
    "Your keys, encrypted.",
    "Bring a key from any of 45 providers; it is encrypted and never shown again.",
  ],
  [
    "Every call on record.",
    "See each model call made with your keys: model, tokens, status and time.",
  ],
  ["Your code stays yours.", "Prompts and answers pass through and are never stored or logged."],
];

function Halftone() {
  return (
    <svg
      className="si-dots"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="si-p"
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(30)"
        >
          <circle cx="7" cy="7" r="2.4" fill="#ff3d7f" />
        </pattern>
        <pattern
          id="si-a"
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(30) translate(4 3)"
        >
          <circle cx="7" cy="7" r="2" fill="#7fffd4" />
        </pattern>
        <radialGradient id="si-g" cx="0.5" cy="0.45" r="0.75">
          <stop offset="0" stopColor="#fff" stopOpacity=".05" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".16" />
          <stop offset="1" stopColor="#fff" stopOpacity=".6" />
        </radialGradient>
        <mask id="si-m">
          <rect width="1440" height="900" fill="url(#si-g)" />
        </mask>
      </defs>
      <g mask="url(#si-m)">
        <rect width="1440" height="900" fill="url(#si-p)" opacity=".5" />
        <rect width="1440" height="900" fill="url(#si-a)" opacity=".65" />
      </g>
    </svg>
  );
}

// A corner orb: radials from a hub near the corner, a sagging spiral.
function Web() {
  const HX = 120;
  const HY = 96;
  const radials = Array.from(
    { length: 19 },
    (_, i) => (i * 2 * Math.PI) / 19 + 0.08 * Math.sin(i * 7),
  );
  const reach = (a: number) => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = 380 * (0.85 + 0.1 * Math.sin(a * 5));
    if (dx < 0) t = Math.min(t, HX / -dx);
    if (dy < 0) t = Math.min(t, HY / -dy);
    return t;
  };
  const at = (a: number, r: number): [number, number] => [
    HX + r * Math.cos(a),
    HY + r * Math.sin(a),
  ];
  const spokes = radials.map((a) => {
    const [x, y] = at(a, reach(a));
    return `M${HX} ${HY}L${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  let spiral = "";
  let prev: [number, number] | null = null;
  for (let r = 26, k = 0; r < 380; k++) {
    const a = radials[k % radials.length] ?? 0;
    r += 0.62 + r * 0.004;
    const [x, y] = at(a, r);
    if (r > reach(a) * 0.96 || x < 1 || y < 1) {
      prev = null;
      continue;
    }
    if (!prev) spiral += `M${x.toFixed(1)} ${y.toFixed(1)}`;
    else {
      const mx = (prev[0] + x) / 2;
      const my = (prev[1] + y) / 2;
      spiral += `Q${(mx + (HX - mx) * 0.07).toFixed(1)} ${(my + (HY - my) * 0.07).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    prev = [x, y];
  }
  return (
    <svg className="si-web" viewBox="0 0 420 420" aria-hidden="true">
      <defs>
        <radialGradient id="si-wg" gradientUnits="userSpaceOnUse" cx={HX} cy={HY} r="400">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".6" stopColor="#fff" stopOpacity=".8" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="si-wm">
          <rect width="420" height="420" fill="url(#si-wg)" />
        </mask>
      </defs>
      <g mask="url(#si-wm)" fill="none" stroke="#f4f2ea">
        <path d={spokes.join("")} strokeOpacity=".34" strokeWidth=".9" />
        <path d={spiral} strokeOpacity=".28" strokeWidth=".75" />
      </g>
    </svg>
  );
}

export function SignIn(props: { next?: string }) {
  const device = props.next?.startsWith("/device");
  return (
    <div className="si">
      <Halftone />
      <Web />
      <div className="si-inner">
        <div className="si-spider">
          <SpiderMark size={132} dark glitch={2} label="ocra" />
        </div>
        <h1 className="si-title">
          {device ? (
            <>
              Sign in to <em>connect your terminal.</em>
            </>
          ) : (
            <>
              Code review agents, <em>with your own keys.</em>
            </>
          )}
        </h1>
        <div className="si-card">
          <p className="si-lead">
            {device
              ? "After signing in you will confirm the code shown by ocra login."
              : "Sign in to manage provider keys and see what ocra does with them."}
          </p>
          <a
            className="si-btn"
            href={`/api/auth/github/login${props.next ? `?next=${encodeURIComponent(props.next)}` : ""}`}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d={GITHUB_PATH} />
            </svg>
            Continue with GitHub <i aria-hidden="true">&rarr;</i>
          </a>
          <ul className="si-points">
            {POINTS.map(([t, d]) => (
              <li key={t}>
                <span>
                  <strong>{t}</strong> {d}
                </span>
              </li>
            ))}
          </ul>
          <p className="si-fine">
            ocra Cloud is in early access. <a href="/privacy">What it stores</a>
          </p>
        </div>
      </div>
    </div>
  );
}
