import { EyesMark } from "./eyes.js";
import { anyProvider } from "./site.js";
import { signInHref, useProviders, useSignInMethods } from "./ui.js";
import "./signin.css";

// The signed-out screen: the headline and, beside it, a panel with the one
// action.

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

// Archivo's latin cut has no arrow, so the button draws its own (as the
// landing page's ArrowGlyph does).
function Arrow() {
  return (
    <svg className="si-arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M1.5 7h10M7.5 3l4 4-4 4" />
    </svg>
  );
}

export function SignIn(props: { next?: string | undefined }) {
  const device = props.next?.startsWith("/device");
  const providers = useProviders();
  const methods = useSignInMethods();
  return (
    <div className="si">
      <div className="si-head">
        <div className="si-mark" role="img" aria-label="ocra">
          <EyesMark size={64} />
        </div>
        <h1 className="si-title">
          {device ? (
            <>
              <span>Sign in to</span> <span>connect your terminal.</span>
            </>
          ) : (
            <>
              <span>Code review agents,</span> <span>with your own keys.</span>
            </>
          )}
        </h1>
      </div>
      <div className="si-sheet">
        <div className="si-sheet-head" aria-hidden="true">
          <span>ocra cloud · sign in</span>
          <span>early access</span>
        </div>
        <p className="si-lead">
          {device
            ? "After signing in you will confirm the code shown by ocra login."
            : "Sign in to manage provider keys and see what ocra does with them."}
        </p>
        {methods?.map((method) => (
          <a key={method.id} className="si-btn" href={signInHref(method, props.next)}>
            {method.id === "github" && (
              <svg
                width="18"
                height="18"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d={GITHUB_PATH} />
              </svg>
            )}
            Continue with {method.name} <Arrow />
          </a>
        ))}
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
  );
}
