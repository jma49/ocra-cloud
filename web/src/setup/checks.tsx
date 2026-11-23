import { Button } from "@/components/ui/button";
import type { SetupCheck, SetupHealth } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { LoadError, Loading, useLoad } from "../ui.js";

// What a test found, a line per thing it reached: a badge, what happened,
// and what to change when it failed. A check named as its section shows no
// title of its own.

export function CheckList(props: { checks: SetupCheck[]; section?: string }) {
  return (
    <ul className="setup-checks" aria-label="Test results">
      {props.checks.map((c) => (
        <li key={`${c.title}:${c.detail}`} className="setup-check">
          <span className={`badge${c.note ? "" : c.ok ? " badge-ok" : " badge-err"}`}>
            {c.note ? "Note" : c.ok ? "Works" : "Failed"}
          </span>
          <div className="grow">
            {c.title !== props.section && <div className="strong">{c.title}</div>}
            <div>{c.detail}</div>
            {c.fix && <div className="muted">{c.fix}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Every part of the server tested as it runs now. */
export function HealthView() {
  const { data, error, loading, reload } = useLoad(() => api<SetupHealth>("/setup/health"));
  const failed = data?.sections.reduce((n, s) => n + s.checks.filter((c) => !c.ok).length, 0);
  return (
    <section className="setup-health" aria-label="Health">
      <div className="card">
        <div className="card-head">
          <h2>Health</h2>
          <Button type="button" variant="outline" size="sm" onClick={reload} disabled={loading}>
            {loading ? "Testing…" : "Test again"}
          </Button>
        </div>
        <p className="card-pad muted m-0">
          {failed === undefined
            ? "Each part of the server, tested as it runs now, the settings in its environment included."
            : failed === 0
              ? "Every part answers."
              : failed === 1
                ? "One part needs attention: what to change is under it."
                : `${failed} parts need attention: what to change is under each.`}
        </p>
      </div>
      {error && !data ? (
        <LoadError what="the health report" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="the health report" rows={5} />
      ) : (
        data.sections.map((s) => (
          <div key={s.title} className="card">
            <div className="card-head">
              <h2>{s.title}</h2>
            </div>
            <div className="card-pad">
              <CheckList checks={s.checks} section={s.title} />
            </div>
          </div>
        ))
      )}
    </section>
  );
}
