import X from "lucide-react/icons/x";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadKeys } from "../account-keys.js";
import type { Me, Reviews, Session } from "../api.js";
import { useRead } from "../cache.js";
import { DoneGlyph } from "../glyphs.js";
import { Link } from "../router.js";
import { anyProvider } from "../site.js";
import { useLoad, useProviders, useReloadOnReturn } from "../ui.js";
import { currentStep, type SetupFacts, type SetupStep, setupSteps } from "./steps.js";

type Listed = { platforms: SetupFacts["platforms"] };

const WHY: Record<Exclude<SetupStep["key"], "key">, ReactNode> = {
  connect: "ocra reads pull requests as you, on the platform you connect.",
  choose: "The ocra Cloud app reviews only the repositories you install it on.",
  enroll: "Pick a repository and switch Automatic on: each pull request is reviewed as it opens.",
  cli: (
    <>
      <span className="cmd">npm install -g @open-cr-agent/cli</span> then{" "}
      <span className="cmd">ocra login</span>
    </>
  ),
  review:
    "Open a pull request there, or ask for a review on its page. Findings land on the pull request.",
};

const hiddenKey = (login: string) => `ocra.setup.hidden.${login}`;
function readHidden(login: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(login)) === "1";
  } catch {
    return false;
  }
}

/** What a new account still has to do before its pull requests get reviewed, one step at a time. */
export function GetStarted(props: { me: Me; hideable?: boolean }) {
  const hosted = props.me.autoReview;
  const platforms = useRead<Listed>("/platforms/repos");
  const leaving = useReloadOnReturn(platforms.reload);
  const listed = platforms.data;
  // A server that does not review answers not_found: nothing is enrolled there.
  const enrolled = useRead<{ repos: unknown[] }>("/auto-review/repos");
  const sessions = useRead<{ sessions: Session[] }>("/sessions").data;
  const reviews = useRead<Reviews>("/reviews?days=90").data;
  const { data: keys } = useLoad(loadKeys);
  const providers = useProviders();
  const [hidden, setHidden] = useState(() => readHidden(props.me.login));

  if (!listed || (hosted && !enrolled.data && !enrolled.error) || !sessions || !reviews || !keys)
    return null;
  const steps = setupSteps({
    hosted,
    platforms: listed.platforms,
    keys: keys.keys.length,
    enrolled: enrolled.data?.repos.length ?? 0,
    cliSignedIn: sessions.sessions.some((s) => s.kind === "cli"),
    reviews: reviews.summary.reviews,
  });
  const now = currentStep(steps);
  if (!now || (props.hideable && hidden)) return null;
  const done = steps.filter((s) => s.done).length;
  const hide = () => {
    try {
      localStorage.setItem(hiddenKey(props.me.login), "1");
    } catch {}
    setHidden(true);
  };

  return (
    <section className="section card get-started" aria-labelledby="get-started-title">
      <div className="card-head">
        <h2 id="get-started-title">Set up reviews</h2>
        <span className="row-gap">
          <span className="subtle small">
            {done} of {steps.length} done
          </span>
          {props.hideable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Hide setup"
              title="Hide setup"
              onClick={hide}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </span>
      </div>
      <div className="meter get-started-meter" aria-hidden="true">
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={`step${s.done ? " done" : ""}${s === now ? " current" : ""}`}
            aria-current={s === now ? "step" : undefined}
          >
            <span className="step-n">{s.done ? <DoneGlyph size={14} /> : i + 1}</span>
            <div className="grow">
              <div className="strong">{s.title}</div>
              {s === now && (
                <div className="muted small">
                  {s.key === "key"
                    ? `Reviews run on your own key from ${anyProvider(providers?.length)}, and the provider bills you directly.`
                    : WHY[s.key]}
                </div>
              )}
            </div>
            {s === now && s.to && s.label && <StepAction step={s} onLeave={leaving} />}
            {s.done && <span className="sr-only">Done</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function StepAction(props: { step: SetupStep; onLeave: () => void }) {
  const { to = "", label, external } = props.step;
  if (external)
    return (
      <Button
        size="sm"
        render={<a href={to} target="_blank" rel="noopener noreferrer" />}
        onClick={props.onLeave}
      >
        {label}
      </Button>
    );
  return (
    <Button size="sm" render={<Link to={to} />}>
      {label}
    </Button>
  );
}
