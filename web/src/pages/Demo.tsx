import { Tabs } from "@base-ui/react/tabs";
import CircleCheck from "lucide-react/icons/circle-check";
import FastForward from "lucide-react/icons/fast-forward";
import Pause from "lucide-react/icons/pause";
import Play from "lucide-react/icons/play";
import Radio from "lucide-react/icons/radio";
import RotateCcw from "lucide-react/icons/rotate-ccw";
import { useEffect, useMemo, useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { LiveEventView } from "../../../src/shared/index.js";
import { DEMO_SCENARIOS, type DemoScenario } from "../demo/scenarios.js";
import { sourceLabel, usd, verdictLabel } from "../format.js";
import { LiveFindingEvent } from "../live/finding.js";
import { emptyProgress, fold, shownFindings } from "../live/fold.js";
import { LiveStages } from "../live/progress.js";
import { LiveTasks } from "../live/tasks.js";
import { Link } from "../router.js";
import { EmptyState } from "../ui.js";

// Public, zero-auth live review replay using the console's own live pipeline
// components (LiveStages, LiveTasks, LiveCounts, LiveFindingEvent) and fold().

const RANK = { critical: 0, warning: 1, suggestion: 2 } as const;
const NOOP_ACTIONS = {
  add: async () => false,
  remove: async () => false,
};

function eventLine(e: LiveEventView): { tag: string; label: string; text: string } {
  switch (e.kind) {
    case "started":
      return { tag: "start", label: "Start", text: e.data.target };
    case "stage":
      return {
        tag: e.data.stage,
        label: e.data.stage.charAt(0).toUpperCase() + e.data.stage.slice(1),
        text: e.data.files ? `${e.data.files.length} files selected` : `Stage ${e.data.stage}`,
      };
    case "task.started":
      return {
        tag: "task",
        label: "Task",
        text: `${e.data.reviewer} (${e.data.files.length} files)`,
      };
    case "task.finished":
      return { tag: "done", label: "Done", text: `${e.data.taskId} · ${e.data.status}` };
    case "file.finished":
      return { tag: "file", label: "File", text: `${e.data.path} · ${e.data.status}` };
    case "finding":
      if (e.data.dropped) return { tag: "drop", label: "Refuted", text: e.data.title };
      if (e.data.settled) return { tag: "confirm", label: "Confirm", text: e.data.title };
      return { tag: "claim", label: "Check", text: e.data.title };
    case "warning":
      return { tag: "gate", label: "Gate", text: e.data.message };
    case "usage":
      return {
        tag: "usage",
        label: "Usage",
        text: `${e.data.inputTokens.toLocaleString()} in · ${usd(e.data.costUsd)}`,
      };
    case "finished":
      return {
        tag: "verdict",
        label: "Verdict",
        text: `${verdictLabel(e.data.verdict)} · ${usd(e.data.usage.costUsd)}`,
      };
    case "failed":
      return { tag: "failed", label: "Failed", text: e.data.reason };
  }
}

export function Demo(props: { signedIn?: boolean }) {
  const [scenarioId, setScenarioId] = useState<string>(DEMO_SCENARIOS[0]?.id ?? "session-ttl");
  const scenario: DemoScenario =
    DEMO_SCENARIOS.find((s) => s.id === scenarioId) ?? (DEMO_SCENARIOS[0] as DemoScenario);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [cursor, setCursor] = useState<number>(() => (reduced ? scenario.events.length : 1));
  const [playing, setPlaying] = useState<boolean>(() => !reduced);
  const [fast, setFast] = useState<boolean>(false);

  const selectScenario = (id: string) => {
    const next = DEMO_SCENARIOS.find((s) => s.id === id) ?? scenario;
    setScenarioId(next.id);
    setCursor(reduced ? next.events.length : 1);
    setPlaying(!reduced);
  };

  useEffect(() => {
    if (!playing || cursor >= scenario.events.length) return;
    const next = scenario.events[cursor];
    const delay = Math.max(80, Math.round((next?.delayMs ?? 450) / (fast ? 2 : 1)));
    const id = window.setTimeout(() => {
      setCursor((c) => Math.min(scenario.events.length, c + 1));
    }, delay);
    return () => window.clearTimeout(id);
  }, [playing, cursor, fast, scenario]);

  const seenEvents = useMemo(() => scenario.events.slice(0, cursor), [scenario.events, cursor]);
  const progress = useMemo(() => fold(emptyProgress(), seenEvents), [seenEvents]);
  const ended = progress.ending !== null;
  const { shown, checking } = shownFindings(progress, ended);
  const findings = [...shown].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file),
  );

  const pct = Math.round((cursor / Math.max(1, scenario.events.length)) * 100);

  return (
    <Tabs.Root className="demo-shell" value={scenario.id} onValueChange={selectScenario}>
      <header className="demo-head">
        <div className="demo-head-row">
          <Tabs.List className="demo-tabs" aria-label="Sample pull requests" activateOnFocus>
            {DEMO_SCENARIOS.map((s) => (
              <Tabs.Tab
                key={s.id}
                value={s.id}
                className={`demo-tab${s.id === scenario.id ? " is-active" : ""}`}
                onClick={() => {
                  if (s.id === scenario.id) selectScenario(s.id);
                }}
              >
                {s.tab}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <div className="demo-actions">
            {ended ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCursor(1);
                  setPlaying(true);
                }}
              >
                <RotateCcw size={14} aria-hidden="true" /> Replay
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setPlaying((p) => !p)}>
                  {playing ? (
                    <>
                      <Pause size={14} aria-hidden="true" /> Pause
                    </>
                  ) : (
                    <>
                      <Play size={14} aria-hidden="true" /> Resume
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCursor(scenario.events.length);
                    setPlaying(false);
                  }}
                >
                  <FastForward size={14} aria-hidden="true" /> Skip
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              aria-label="Toggle playback speed"
              onClick={() => setFast((f) => !f)}
            >
              {fast ? "2×" : "1×"}
            </Button>
          </div>
        </div>
        <p className="subtle small m-0">{scenario.summary}</p>
        <div
          className="demo-bar"
          role="progressbar"
          aria-label="Replay progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className={`demo-bar-fill${ended ? " is-done" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </header>

      <Tabs.Panel className="demo-frame" value={scenario.id}>
        <aside className="live-side" aria-label="Progress">
          <div className="live-state">
            <Status tone={ended ? "ok" : "run"}>{ended ? "Finished" : "Running"}</Status>
            {progress.ending?.kind === "finished" && (
              <span>{verdictLabel(progress.ending.verdict)}</span>
            )}
          </div>
          <LiveStages progress={progress} ended={ended} replayAt={seenEvents.at(-1)?.at} />
          <LiveTasks progress={progress} ended={ended} />
          <dl className="prop-list">
            {progress.costUsd > 0 && (
              <>
                <dt>Cost</dt>
                <dd className="mono">{usd(progress.costUsd)}</dd>
              </>
            )}
            <dt>Repository</dt>
            <dd>{scenario.repo}</dd>
            <dt>Source</dt>
            <dd>{sourceLabel(scenario.source)}</dd>
            <dt>Run</dt>
            <dd className="mono subtle">{scenario.runId}</dd>
          </dl>
        </aside>

        <section className="live-main" aria-label="Findings">
          <div className="review-title">
            <span className="subtle small">
              {scenario.repo} #{scenario.prNumber}
            </span>
            <h1>{scenario.title}</h1>
          </div>
          <div className="review-tabs">
            <span className="quiet-label" role="status">
              {ended
                ? `${findings.length} finding${findings.length === 1 ? "" : "s"}`
                : [
                    findings.length > 0 || checking === 0
                      ? `${findings.length} confirmed so far`
                      : null,
                    checking > 0
                      ? `${checking} ${findings.length > 0 ? "more " : ""}being checked`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
          </div>
          {findings.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={ended ? CircleCheck : Radio}
                title={ended ? "No findings" : "No confirmed findings yet"}
              >
                {ended
                  ? "The review ended without a finding. Reporting nothing is a valid outcome."
                  : "A critical finding appears here as soon as it is confirmed. Candidate claims are verified on a second read first."}
              </EmptyState>
            </div>
          ) : (
            <ol className="timeline">
              {findings.map((f) => (
                <LiveFindingEvent
                  key={f.id}
                  f={f}
                  comments={[]}
                  canComment={false}
                  actions={NOOP_ACTIONS}
                />
              ))}
            </ol>
          )}
          {progress.warnings.length > 0 && (
            <div className="note">
              {progress.warnings.map((w) => (
                <p key={w} className="m-0">
                  {w}
                </p>
              ))}
            </div>
          )}
        </section>

        <aside className="demo-stream-panel" aria-label="Pipeline stream">
          <div className="demo-stream-head">
            <h2>Event stream</h2>
            <span className="mono subtle small">
              {cursor}/{scenario.events.length}
            </span>
          </div>
          <ol className="demo-stream">
            {[...seenEvents].reverse().map((e) => {
              const line = eventLine(e);
              return (
                <li key={e.seq} className={`demo-ev is-${line.tag}`}>
                  <span className="demo-ev-tag">{line.label}</span>
                  <span className="demo-ev-text">{line.text}</span>
                </li>
              );
            })}
          </ol>
          <div className="card demo-cta">
            <p className="strong m-0">Run this on your own pull requests</p>
            <p className="subtle small m-0">
              Free during early access. Bring your own model key for GitHub or GitLab.
            </p>
            <Button render={<Link to="/" />}>
              {props.signedIn ? "Open your inbox" : "Sign in with GitHub"}
            </Button>
          </div>
        </aside>
      </Tabs.Panel>
    </Tabs.Root>
  );
}
