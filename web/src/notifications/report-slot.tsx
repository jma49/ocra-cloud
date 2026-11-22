import type { ReportScheduleView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { time } from "../format.js";
import { ActionError, useAction, useLoad } from "../ui.js";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Slot = { weekday: number; hour: number };

/** When the weekly report goes: picked in UTC, the next one shown in the viewer's time. */
export function ReportSlot() {
  const { data, reload } = useLoad(() => api<ReportScheduleView>("/notifications/report"));
  const save = useAction((slot: Slot) =>
    api<ReportScheduleView>("/notifications/report", {
      method: "PUT",
      body: JSON.stringify(slot),
    }),
  );
  if (!data) return null;
  const set = async (slot: Slot) => {
    if ((await save.run(slot)) !== undefined) reload();
  };
  return (
    <div className="card card-pad stack report-slot">
      <div className="strong">Weekly report</div>
      <div className="report-when">
        <span>Sent every</span>
        <select
          className="input"
          aria-label="Weekly report day"
          value={data.weekday}
          disabled={save.busy}
          onChange={(e) => set({ weekday: Number(e.target.value), hour: data.hour })}
        >
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
        <span>at</span>
        <select
          className="input"
          aria-label="Weekly report hour"
          value={data.hour}
          disabled={save.busy}
          onChange={(e) => set({ weekday: data.weekday, hour: Number(e.target.value) })}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, "0")}:00
            </option>
          ))}
        </select>
        <span>UTC</span>
      </div>
      <span className="subtle small">
        Next on {time(data.next)}, your time. It covers the seven days before and goes to the
        channels with Weekly on; a week without reviews or merges sends nothing.
      </span>
      {save.error !== null && <ActionError what="change the report day" error={save.error} />}
    </div>
  );
}
