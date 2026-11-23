import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import type { PullActionOutcome, PullLabel, PullLabelsView } from "../../../src/shared/index.js";
import { api, why } from "../api.js";
import { useRead } from "../cache.js";
import { useAction } from "../ui.js";

// The pull request's labels, added and removed one at a time as the
// signed-in user, from the repository's own labels.

type Pull = { platform: string; repo: string; number: number };

function Dot(props: { color: string | null }) {
  return (
    <i
      className="label-dot"
      aria-hidden="true"
      style={props.color ? { background: props.color } : undefined}
    />
  );
}

export function LabelsBox(props: { pull: Pull; onDone: (o: PullActionOutcome) => void }) {
  const query = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, error, reload } = useRead<PullLabelsView>(`/pulls/labels?${query}`);
  const edit = useAction((name: string, on: boolean) =>
    api<{ outcome: PullActionOutcome }>("/pulls/labels", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, add: on ? [name] : [], remove: on ? [] : [name] }),
    }),
  );
  if (error && !data) {
    return <p className="error small">Could not read the labels: {why(error)}.</p>;
  }
  if (!data || (data.applied.length === 0 && data.available.length === 0)) return null;
  const known = new Map(data.available.map((l) => [l.name, l]));
  const applied: PullLabel[] = data.applied.map(
    (name) => known.get(name) ?? { name, color: null, description: null },
  );
  const toggle = async (name: string, on: boolean) => {
    const r = await edit.run(name, on);
    if (!r) return;
    props.onDone(r.outcome);
    if (r.outcome === "done") reload();
  };
  return (
    <section className="card card-pad stack" aria-label="Labels">
      <div className="row-gap checks-head">
        <span className="strong grow">Labels</span>
        {data.available.length > 0 && (
          <Menu>
            <MenuTrigger render={<Button type="button" variant="outline" size="sm" />}>
              Edit
            </MenuTrigger>
            <MenuPopup align="end" className="label-menu">
              {data.available.map((l) => (
                <MenuCheckboxItem
                  key={l.name}
                  checked={data.applied.includes(l.name)}
                  disabled={edit.busy}
                  closeOnClick={false}
                  onCheckedChange={(on) => toggle(l.name, on)}
                >
                  <span className="label-item" title={l.description ?? undefined}>
                    <Dot color={l.color} />
                    {l.name}
                  </span>
                </MenuCheckboxItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
      </div>
      {applied.length === 0 ? (
        <span className="subtle small">None yet.</span>
      ) : (
        <ul className="label-list">
          {applied.map((l) => (
            <li key={l.name} className="badge" title={l.description ?? undefined}>
              <Dot color={l.color} />
              {l.name}
            </li>
          ))}
        </ul>
      )}
      {data.truncated && (
        <span className="subtle small">
          The repository has more labels than this list reads; the rest are on the platform.
        </span>
      )}
      {edit.error !== null && (
        <p className="error" role="alert">
          Could not change the labels: {why(edit.error)}.
        </p>
      )}
    </section>
  );
}
