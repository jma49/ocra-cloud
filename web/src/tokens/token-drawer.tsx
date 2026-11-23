import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  API_TOKEN_NAME_MAX,
  API_TOKEN_ROUTES,
  API_TOKEN_SCOPES,
  type ApiTokenCreated,
  type ApiTokenDraft,
  type ApiTokenScope,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { Drawer } from "../drawer.js";
import { Row } from "../form.js";
import { ActionError, Seg, useAction } from "../ui.js";

// A new API token: its name, what it may read and how long it lives.

export const SCOPE_LABEL: Record<ApiTokenScope, string> = {
  "reviews:read": "Reviews",
  "insights:read": "Insights",
  "pulls:read": "Pull requests",
};
const LIFETIMES = [7, 30, 90, 365].map((d) => ({ value: d, label: `${d} days` }));

const routesOf = (scope: ApiTokenScope) =>
  Object.entries(API_TOKEN_ROUTES)
    .filter(([, s]) => s === scope)
    .map(([route]) => route);

export function TokenDrawer(props: { done: (made?: ApiTokenCreated) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>([]);
  const [days, setDays] = useState(30);
  const make = useAction(() =>
    api<ApiTokenCreated>("/tokens", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        scopes,
        expiresInDays: days,
      } satisfies ApiTokenDraft),
    }),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const made = await make.run();
    if (made !== undefined) props.done(made);
  };
  return (
    <Drawer
      title="New API token"
      onClose={() => props.done()}
      onSubmit={submit}
      foot={
        <>
          <Button type="button" variant="outline" onClick={() => props.done()}>
            Cancel
          </Button>
          <Button type="submit" disabled={make.busy || name.trim() === "" || scopes.length === 0}>
            Make token
          </Button>
        </>
      }
    >
      {make.error !== null && <ActionError what="make the token" error={make.error} />}
      <Row label="Name" desc="What it is for, so you can tell it apart later.">
        <input
          className="input"
          aria-label="Token name"
          maxLength={API_TOKEN_NAME_MAX}
          placeholder="e.g. Nightly report"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Row>
      <Row label="May read" desc="A token only reads, and only what is ticked here.">
        <div className="scope-list">
          {API_TOKEN_SCOPES.map((s) => (
            <label className="scope" key={s}>
              <input
                type="checkbox"
                aria-label={SCOPE_LABEL[s]}
                checked={scopes.includes(s)}
                onChange={(e) =>
                  setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
                }
              />
              <span>
                {SCOPE_LABEL[s]}
                <span className="scope-routes mono subtle">{routesOf(s).join("\n")}</span>
              </span>
            </label>
          ))}
        </div>
      </Row>
      <Row label="Expires in" desc="Every token expires; make a new one when it does.">
        <Seg label="Expires in" value={days} options={LIFETIMES} onChange={setDays} />
      </Row>
    </Drawer>
  );
}
