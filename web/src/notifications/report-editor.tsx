import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type NotifyTimeZoneView,
  REPORT_CADENCES,
  REPORT_SECTIONS,
  type ReportSection,
  type ScheduledReportPreview,
  type ScheduledReportTiming,
  type ScheduledReportView,
} from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useRead } from "../cache.js";
import { Drawer } from "../drawer.js";
import { Checks, Row } from "../form.js";
import { time } from "../format.js";
import { Seg, useAction } from "../ui.js";
import { clock } from "./reminders-drawer.js";

type Choice = { id: string; label: string };
type Cadence = ScheduledReportTiming["cadence"];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MONTH_DAYS = Array.from({ length: 28 }, (_, d) => d + 1);
const CADENCE_LABEL: Record<Cadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
const SECTION_LABEL: Record<ReportSection, string> = {
  reviews: "Reviews, by severity",
  outcomes: "Findings fixed, dismissed and still open",
  open_findings: "The most serious open findings",
  merged: "Merged pull requests",
  time_to_merge: "Median time to merge",
  top_repos: "The repositories reviewed most",
};
/** Long enough that typing a change asks once, not per keystroke. */
const PREVIEW_DELAY_MS = 800;

/** When a report goes, in words. */
export function whenOf(t: ScheduledReportTiming): string {
  const at = `at ${clock(t.hour)}`;
  if (t.cadence === "weekly") return `Every ${WEEKDAYS[t.weekday ?? 0]} ${at}`;
  if (t.cadence === "monthly") return `On day ${t.monthDay ?? 1} of each month ${at}`;
  return `Every day ${at}`;
}

/** What saving a report sends: the view without what the server makes. */
export const reportBody = (r: ScheduledReportView) => ({
  name: r.name,
  enabled: r.enabled,
  cadence: r.cadence,
  hour: r.hour,
  weekday: r.weekday,
  monthDay: r.monthDay,
  repoIds: r.repoIds,
  sections: r.sections,
  channelIds: r.channelIds,
});

/** One report, new or changed, with what it would hold for its period so far. */
export function ReportEditor(props: {
  report?: ScheduledReportView | undefined;
  channels: Choice[];
  /** Enrolled repositories; none where this server enrolls none. */
  repos: Choice[];
  done: (saved: boolean) => void;
}) {
  const r = props.report;
  const zone = useRead<NotifyTimeZoneView>("/notifications/time-zone");
  const [name, setName] = useState(r?.name ?? "");
  const [cadence, setCadence] = useState<Cadence>(r?.cadence ?? "weekly");
  const [hour, setHour] = useState(r?.hour ?? 9);
  const [weekday, setWeekday] = useState(r?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(r?.monthDay ?? 1);
  const [repoIds, setRepoIds] = useState(r?.repoIds ?? []);
  const [sections, setSections] = useState<string[]>(r?.sections ?? ["reviews", "merged"]);
  const [channelIds, setChannelIds] = useState(
    r?.channelIds ?? (props.channels.length === 1 ? props.channels.map((c) => c.id) : []),
  );
  const [preview, setPreview] = useState<ScheduledReportPreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);

  const content = {
    cadence,
    hour,
    weekday: cadence === "weekly" ? weekday : null,
    monthDay: cadence === "monthly" ? monthDay : null,
    repoIds: repoIds.length ? repoIds : null,
    sections: REPORT_SECTIONS.filter((s) => sections.includes(s)),
  };
  const asked = JSON.stringify(content);
  useEffect(() => {
    const body: typeof content = JSON.parse(asked);
    if (body.sections.length === 0) return setPreview(null);
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const made = await api<ScheduledReportPreview>("/scheduled-reports/preview", {
          method: "POST",
          body: asked,
        });
        if (!live) return;
        setPreview(made);
        setPreviewError(null);
      } catch (e) {
        if (live) setPreviewError(e);
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asked]);

  const save = useAction(() =>
    api(r ? `/scheduled-reports/${r.id}` : "/scheduled-reports", {
      method: r ? "PUT" : "POST",
      body: JSON.stringify({
        name: name.trim(),
        enabled: r?.enabled ?? true,
        ...content,
        channelIds,
      }),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.run()) !== undefined) props.done(true);
  };
  const ready = name.trim() !== "" && content.sections.length > 0 && channelIds.length > 0;
  const timeZone = r?.timeZone ?? zone.data?.timeZone ?? "UTC";

  return (
    <Drawer
      title={r ? `Edit ${r.name}` : "New report"}
      heading={r ? `Edit “${r.name}”` : "New report"}
      onClose={() => props.done(false)}
      onSubmit={submit}
      foot={
        <>
          {save.error !== null && (
            <span className="error small grow" role="alert">
              Could not save it: {why(save.error)}.
            </span>
          )}
          <Button type="button" variant="outline" onClick={() => props.done(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.busy || !ready}>
            {r ? "Save report" : "Add report"}
          </Button>
        </>
      }
    >
      <Row label="Name" desc="How the report shows here and in its subject.">
        <input
          className="input"
          aria-label="Report name"
          maxLength={64}
          placeholder="e.g. Payments, every Monday"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Row>
      <Row
        label="Sent"
        desc={`In ${timeZone}, the account's time zone. Each report covers the time since the one before; a period with no reviews and no merges sends nothing.`}
      >
        <div className="report-timing">
          <Seg
            label="How often"
            value={cadence}
            onChange={setCadence}
            options={REPORT_CADENCES.map((c) => ({ value: c, label: CADENCE_LABEL[c] }))}
          />
          <div className="report-when">
            {cadence === "weekly" && (
              <>
                <span>on</span>
                <select
                  className="input"
                  aria-label="Day of the week"
                  value={weekday}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </>
            )}
            {cadence === "monthly" && (
              <>
                <span>on day</span>
                <select
                  className="input"
                  aria-label="Day of the month"
                  value={monthDay}
                  onChange={(e) => setMonthDay(Number(e.target.value))}
                >
                  {MONTH_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span>at</span>
            <select
              className="input"
              aria-label="Hour"
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {clock(h)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Row>
      {props.repos.length > 0 && (
        <Row label="Repositories" desc="Only these are counted; none ticked counts every one.">
          <Checks items={props.repos} value={repoIds} onChange={setRepoIds} what="Repository" />
        </Row>
      )}
      <Row
        label="Sections"
        desc="At least one. Finding titles and open counts need the account to share findings."
      >
        <Checks
          items={REPORT_SECTIONS.map((s) => ({ id: s, label: SECTION_LABEL[s] }))}
          value={sections}
          onChange={setSections}
          what="Section"
        />
      </Row>
      <Row label="Sent to" desc="At least one channel. It gets the report whatever else it hears.">
        <Checks items={props.channels} value={channelIds} onChange={setChannelIds} what="Channel" />
      </Row>
      <section className="report-preview" aria-label="Preview">
        <div className="label">Preview</div>
        {previewError !== null ? (
          <p className="error small m-0" role="alert">
            Could not make the preview: {why(previewError)}.
          </p>
        ) : content.sections.length === 0 ? (
          <p className="subtle small m-0">Tick a section to see the report.</p>
        ) : !preview ? (
          <p className="subtle small m-0">Making the preview…</p>
        ) : (
          <>
            <p className="subtle small m-0">
              What it would hold from {time(preview.period.from)} to now.
              {preview.empty &&
                " Nothing was reviewed or merged yet, so its slot would send nothing."}
            </p>
            <div className="report-message">
              <div className="strong">{preview.subject}</div>
              {preview.lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines of one message, never reordered
                <div key={i}>{line || " "}</div>
              ))}
            </div>
          </>
        )}
      </section>
    </Drawer>
  );
}
