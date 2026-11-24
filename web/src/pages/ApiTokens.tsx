import KeySquare from "lucide-react/icons/key-square";
import { useState } from "react";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  API_TOKEN_MAX,
  type ApiTokenCreated,
  type ApiTokenView,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import { useRead } from "../cache.js";
import { CopyButton } from "../copy-button.js";
import { ago, date } from "../format.js";
import { AddGlyph } from "../glyphs.js";
import { StackTable } from "../stack-table.js";
import { SCOPE_LABEL, TokenDrawer } from "../tokens/token-drawer.js";
import { ActionError, EmptyState, LoadError, Loading, PageHead, useAction } from "../ui.js";

const SOON_MS = 7 * 86_400_000;

export function ApiTokens() {
  const { data, error, reload } = useRead<{ tokens: ApiTokenView[] }>("/tokens");
  const [adding, setAdding] = useState(false);
  /** Held only until it is dismissed: the server never answers it again. */
  const [made, setMade] = useState<ApiTokenCreated | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const revoke = useAction((id: string) => api(`/tokens/${id}`, { method: "DELETE" }));
  const full = (data?.tokens.length ?? 0) >= API_TOKEN_MAX;

  const remove = async (id: string) => {
    if ((await revoke.run(id)) === undefined) return;
    setConfirming(null);
    if (made?.token.id === id) setMade(null);
    reload();
  };
  const newToken = (
    <Button type="button" disabled={full} onClick={() => setAdding(true)}>
      <AddGlyph size={14} /> New token
    </Button>
  );

  return (
    <>
      <PageHead
        title="API tokens"
        sub="Let a script or a CI job read your reviews, insights and pull requests. A token never changes anything."
        actions={data && data.tokens.length > 0 ? newToken : undefined}
      />
      {made && (
        <section className="card card-pad stack-tight token-made" aria-label="Your new token">
          <div className="strong">Copy “{made.token.name}” now</div>
          <p className="muted small m-0">
            This is the only time it is shown. Send it as{" "}
            <span className="mono">Authorization: Bearer</span> followed by the token.
          </p>
          <div className="token-secret">
            <code className="mono">{made.secret}</code>
            <CopyButton text={made.secret} label="Copy token" said="Token copied" iconOnly />
            <Button type="button" variant="outline" size="sm" onClick={() => setMade(null)}>
              Done
            </Button>
          </div>
        </section>
      )}
      {revoke.error !== null && <ActionError what="revoke the token" error={revoke.error} />}
      {error && !data ? (
        <LoadError what="your tokens" error={error} retry={reload} />
      ) : !data ? (
        <Loading what="tokens" />
      ) : data.tokens.length === 0 ? (
        <div className="card">
          <EmptyState icon={KeySquare} title="No tokens yet" action={newToken}>
            Make one for each script or job, with only what it needs to read.
          </EmptyState>
        </div>
      ) : (
        <div className="card">
          <StackTable>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>May read</th>
                  <th className="hide-narrow">Starts with</th>
                  <th className="hide-narrow">Last used</th>
                  <th>Expires</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tokens.map((t) => (
                  <tr key={t.id}>
                    <td className="text strong">{t.name}</td>
                    <td className="text muted">{t.scopes.map((s) => SCOPE_LABEL[s]).join(", ")}</td>
                    <td className="mono hide-narrow">{t.prefix}…</td>
                    <td className="muted hide-narrow">
                      {t.lastUsedAt ? ago(t.lastUsedAt) : "Never"}
                    </td>
                    <td className="muted">
                      {date(t.expiresAt)}
                      {new Date(t.expiresAt).getTime() - Date.now() < SOON_MS && (
                        <>
                          {" "}
                          <Status tone="warn">Soon</Status>
                        </>
                      )}
                    </td>
                    <td className="num">
                      {confirming === t.id ? (
                        <span className="row-gap token-confirm">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={revoke.busy}
                            onClick={() => remove(t.id)}
                          >
                            Confirm: revoke
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="destructive-outline"
                          size="sm"
                          aria-label={`Revoke ${t.name}`}
                          onClick={() => setConfirming(t.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StackTable>
          {full && (
            <p className="subtle small card-pad m-0">
              {API_TOKEN_MAX} tokens is the most an account holds. Revoke one to make another.
            </p>
          )}
        </div>
      )}
      {adding && (
        <TokenDrawer
          done={(created) => {
            setAdding(false);
            if (created) {
              setMade(created);
              reload();
            }
          }}
        />
      )}
    </>
  );
}
