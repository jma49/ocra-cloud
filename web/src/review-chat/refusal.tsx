import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { parseModelId } from "../../../src/shared/index.js";
import { why } from "../api.js";
import { Link } from "../router.js";
import { ChatRefusal } from "./stream.js";

/** The part of a model's name a reader knows it by. */
export const modelName = (id: string) => parseModelId(id)?.model ?? id;

/** What stopped an answer, and the one step that lifts it. */
export function Refusal(props: { error: unknown; limit: number; onClear: () => void }) {
  const { error } = props;
  const code = error instanceof ChatRefusal ? error.code : undefined;
  if (code === "no_key") {
    const provider = (error as ChatRefusal).provider;
    return provider ? (
      <Note>
        <span className="grow">There is no key for {provider}, the provider of this model.</span>
        <Button size="sm" variant="outline" render={<Link to="/keys" />}>
          Add a key
        </Button>
      </Note>
    ) : (
      <NoModel refused />
    );
  }
  if (code === "memory_full")
    return (
      <Note>
        <span className="grow">
          This conversation holds its {props.limit} messages. Clear it to ask more.
        </span>
        <Button size="sm" variant="outline" onClick={props.onClear}>
          Clear conversation
        </Button>
      </Note>
    );
  if (code === "daily_limit")
    return (
      <Note>
        <span className="grow">Today's model calls are used up. Ask again tomorrow (UTC).</span>
        <Button size="sm" variant="outline" render={<Link to="/budget" />}>
          See the budget
        </Button>
      </Note>
    );
  if (code === "upstream_unreachable")
    return (
      <Note>The model's provider did not answer. Your question is kept below; ask again.</Note>
    );
  return <Note>Could not answer: {why(error)}.</Note>;
}

/** The account has set no model to ask: said before any question, or as what refused one. */
export function NoModel(props: { refused?: boolean }) {
  return (
    <Note quiet={!props.refused}>
      <span className="grow">Choose a standard model to ask ocra about a review.</span>
      <Button size="sm" variant="outline" render={<Link to="/agents" />}>
        Choose a model
      </Button>
    </Note>
  );
}

function Note(props: { children: ReactNode; quiet?: boolean }) {
  return (
    <div
      className={`note chat-note small${props.quiet ? "" : " err"}`}
      role={props.quiet ? "status" : "alert"}
    >
      {props.children}
    </div>
  );
}
