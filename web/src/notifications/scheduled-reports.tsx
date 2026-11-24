import Pencil from "lucide-react/icons/pencil";
import Trash2 from "lucide-react/icons/trash-2";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  AutoReviewRepoView,
  NotifyChannelView,
  ScheduledReportSent,
  ScheduledReportsView,
  ScheduledReportView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { count, time } from "../format.js";
import { AddGlyph } from "../glyphs.js";
import { ActionError, LoadError, Loading, useAction, useLoad } from "../ui.js";
import { ReportEditor, reportBody, whenOf } from "./report-editor.js";

// Reports the account defines itself: each goes on its own cadence, counts
// the repositories it names and holds the sections it picks. They ignore a
// channel's own choice of what it hears about.

type Sent = { name: string; result: ScheduledReportSent };

export function ScheduledReports(props: {
  channels: NotifyChannelView[];
  /** Whether this server enrolls repositories a report can be narrowed to. */
  enrolls: boolean;
}) {
  const list = useCached("/scheduled-reports", () =>
    api<ScheduledReportsView>("/scheduled-reports"),
  );
  const repos = useLoad(
    () =>
      props.enrolls
        ? api<{ repos: AutoReviewRepoView[] }>("/auto-review/repos")
        : Promise.resolve({ repos: [] }),
    [props.enrolls],
  );
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const toggle = useAction((r: ScheduledReportView) =>
    api(`/scheduled-reports/${r.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...reportBody(r), enabled: !r.enabled }),
    }),
  );
  const remove = useAction((id: string) => api(`/scheduled-reports/${id}`, { method: "DELETE" }));
  const send = useAction((id: string) =>
    api<ScheduledReportSent>(`/scheduled-reports/${id}/send`, { method: "POST" }),
  );
  // A report goes to people: a webhook takes none.
  const channels = props.channels
    .filter((c) => c.kind !== "webhook")
    .map((c) => ({ id: c.id, label: c.confirmed ? c.name : `${c.name} (awaiting confirmation)` }));
  const repoChoices = (repos.data?.repos ?? []).map((r) => ({ id: r.id, label: r.fullName }));
  const reports = list.data?.reports ?? [];
  const full = list.data ? reports.length >= list.data.max : true;

  // The switch moves at once; a refused save puts it back.
  const flip = async (r: ScheduledReportView) => {
    const undo = list.change((d) => ({
      ...d,
      reports: d.reports.map((x) => (x.id === r.id ? { ...x, enabled: !r.enabled } : x)),
    }));
    if ((await toggle.run(r)) === undefined) undo();
    else list.reload();
  };
  const sendNow = async (r: ScheduledReportView) => {
    setSent(null);
    const result = await send.run(r.id);
    if (!result) return;
    setSent({ name: r.name, result });
    list.reload();
  };

  return (
    <section className="card section rule-list" aria-label="Custom reports">
      <div className="card-head">
        <h2>Custom reports</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full || channels.length === 0}
          onClick={() => setEditing("new")}
        >
          <AddGlyph size={14} /> New report
        </Button>
      </div>
      {toggle.error !== null && <ActionError what="change the report" error={toggle.error} />}
      {remove.error !== null && <ActionError what="remove the report" error={remove.error} />}
      {send.error !== null && <ActionError what="send the report" error={send.error} />}
      {sent && (
        <p className="note ok" role="status">
          <span>
            Sent “{sent.name}” to {sent.result.delivered} of{" "}
            {count(sent.result.channels, "channel")}
            {sent.result.empty && ", though its period has no reviews or merges yet"}.
          </span>
        </p>
      )}
      {list.error && !list.data ? (
        <LoadError what="your reports" error={list.error} retry={list.reload} inCard />
      ) : !list.data ? (
        <Loading what="reports" inCard />
      ) : reports.length === 0 ? (
        <p className="subtle small card-pad m-0">
          {channels.length === 0
            ? "Add a chat, an email address or a direct message above first: a report goes to people, not to a webhook."
            : "Define a report of your own: daily, weekly or monthly, for the repositories and sections you pick, sent to the channels you choose."}
        </p>
      ) : (
        reports.map((r) => (
          <div className="list-row" key={r.id}>
            <Switch
              aria-label={`${r.name} on`}
              checked={r.enabled}
              disabled={toggle.busy}
              onCheckedChange={() => flip(r)}
            />
            <div className={r.enabled ? "grow" : "grow rule-off"}>
              <div className="strong">{r.name}</div>
              <div className="subtle small">
                {whenOf(r)}, {r.timeZone} · {count(r.sections.length, "section")} ·{" "}
                {r.repoIds
                  ? count(r.repoIds.length, "repository", "repositories")
                  : "every repository"}{" "}
                · {count(r.channelIds.length, "channel")}
              </div>
              <div className="subtle small">
                {r.enabled ? `Next on ${time(r.next)}, your time` : "Off"}
                {r.lastSent && ` · last sent ${time(r.lastSent.at)}`}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={send.busy}
              aria-label={`Send ${r.name} now`}
              onClick={() => sendNow(r)}
            >
              Send now
            </Button>
            <button
              type="button"
              className="icon-btn row-action"
              aria-label={`Edit ${r.name}`}
              title="Edit"
              onClick={() => setEditing(r.id)}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn row-action is-danger"
              disabled={remove.busy}
              aria-label={`Remove ${r.name}`}
              title="Remove"
              onClick={async () => {
                if ((await remove.run(r.id)) !== undefined) list.reload();
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))
      )}
      {editing !== null && (
        <ReportEditor
          report={reports.find((r) => r.id === editing)}
          channels={channels}
          repos={repoChoices}
          done={(saved) => {
            setEditing(null);
            if (saved) list.reload();
          }}
        />
      )}
    </section>
  );
}
