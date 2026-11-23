import { Button } from "@/components/ui/button";
import type { PullActionOutcome, PullDraftView } from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useAction, useLoad } from "../ui.js";

type Pull = { platform: string; repo: string; number: number };

/** Makes an open pull request a draft or ready for review, as the signed-in user. */
export function DraftToggle(props: {
  pull: Pull;
  /** Whether marking it ready is the page's next step. */
  primary: boolean;
  onDone: (o: PullActionOutcome) => void;
}) {
  const query = new URLSearchParams({ ...props.pull, number: String(props.pull.number) });
  const { data, reload } = useLoad(
    () => api<PullDraftView>(`/pulls/draft?${query}`),
    [query.toString()],
  );
  const set = useAction((draft: boolean) =>
    api<{ outcome: PullActionOutcome }>("/pulls/draft", {
      method: "POST",
      body: JSON.stringify({ ...props.pull, draft }),
    }),
  );
  if (data?.state !== "open") return null;
  const flip = async () => {
    const r = await set.run(!data.draft);
    if (!r) return;
    props.onDone(r.outcome);
    if (r.outcome === "done") reload();
  };
  return (
    <Button
      variant={data.draft && props.primary ? "default" : "outline"}
      size="sm"
      loading={set.busy}
      onClick={flip}
    >
      {data.draft ? "Mark ready for review" : "Convert to draft"}
    </Button>
  );
}
