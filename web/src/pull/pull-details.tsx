import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_TITLE_CHARS,
  type PullActionOutcome,
  type PullOpenness,
} from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { Drawer } from "../drawer.js";
import { useToast } from "../toast.js";
import { useAction } from "../ui.js";

// The pull request's title edited, and the pull request closed or
// reopened, as the signed-in user. A title someone changed since the page
// read it is refused rather than overwritten.

type Pull = { platform: string; repo: string; number: number };

const send = (path: string, body: unknown) =>
  api<{ outcome: PullActionOutcome }>(path, { method: "POST", body: JSON.stringify(body) });

const STALE = "someone changed it since this page loaded; reload to see their title";

export function EditTitle(props: {
  pull: Pull;
  /** The title as the page read it. */
  title: string;
  onDone: (o: PullActionOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(props.title);
  const save = useAction(() =>
    send("/pulls/details", { ...props.pull, title: { from: props.title, to: text } }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await save.run();
    if (!r) return;
    setOpen(false);
    props.onDone(r.outcome);
  };
  const stale = save.error instanceof ApiError && save.error.code === "stale";
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setText(props.title);
          setOpen(true);
        }}
      >
        Edit title
      </Button>
      {open && (
        <Drawer
          title="Title"
          heading="Pull request title"
          onClose={() => setOpen(false)}
          onSubmit={submit}
          foot={
            <Button
              type="submit"
              loading={save.busy}
              disabled={text.trim() === "" || text === props.title}
            >
              Save title
            </Button>
          }
        >
          <input
            className="input"
            aria-label="Pull request title"
            maxLength={MAX_TITLE_CHARS}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {save.error !== null && (
            <p className="error" role="alert">
              Could not save the title: {stale ? STALE : why(save.error)}.
            </p>
          )}
        </Drawer>
      )}
    </>
  );
}

/** Closes an open pull request or reopens a closed one; a merged one shows nothing. */
export function OpenClose(props: {
  pull: Pull;
  state: PullOpenness;
  onDone: (o: PullActionOutcome) => void;
}) {
  const to: PullOpenness = props.state === "open" ? "closed" : "open";
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const flip = async () => {
    setBusy(true);
    try {
      props.onDone((await send("/pulls/state", { ...props.pull, state: to })).outcome);
    } catch (e) {
      toast(`Could not ${to === "closed" ? "close" : "reopen"} it: ${why(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" loading={busy} onClick={flip}>
      {to === "closed" ? "Close pull request" : "Reopen pull request"}
    </Button>
  );
}
