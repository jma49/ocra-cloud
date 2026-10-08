import { EyesMark } from "./eyes.js";
import { anyProvider } from "./site.js";
import { useProviders } from "./ui.js";
import "./signin.css";

// The signed-out screen, in the landing page's look (ocra-site DESIGN.md):
// the night with silk across it, the eye row, a two-tone headline and a
// card with the one action.

const GITHUB_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

const points = (providers: number | undefined): [string, string][] => [
  [
    "Your keys, encrypted.",
    `Bring a key from ${anyProvider(providers)}; it is encrypted and never shown again.`,
  ],
  [
    "Every call on record.",
    "See each model call made with your keys: model, tokens, status and time.",
  ],
  ["Your code stays yours.", "Prompts and answers pass through and are never stored or logged."],
];

// A few threads of silk across the lower night: the console's still
// version of the site's shader scene (ocra-site components/landing/silk.tsx),
// without the WebGPU library.
function Silk() {
  const threads = Array.from({ length: 9 }, (_, i) => {
    const y0 = 760 + i * 9;
    const y1 = 520 + i * 14;
    const c1 = 640 - i * 22 + (i % 3) * 30;
    const c2 = 610 + i * 12;
    return `M-40 ${y0}C420 ${c1} 980 ${c2} 1480 ${y1}`;
  });
  return (
    <svg
      className="si-silk"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {threads.map((d, i) => (
        <path key={d} d={d} className={i % 3 === 1 ? "t t-light" : "t"} />
      ))}
    </svg>
  );
}

export function SignIn(props: { next?: string | undefined }) {
  const device = props.next?.startsWith("/device");
  const providers = useProviders();
  return (
    <div className="si">
      <Silk />
      <div className="si-inner">
        <div className="si-mark" role="img" aria-label="ocra">
          <EyesMark size={132} />
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
            {points(providers?.length).map(([t, d]) => (
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
