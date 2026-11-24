import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AutoReviewRepoView, RepoAccessTokenView } from "../../../src/shared/index.js";
import { ApiError, api, why } from "../api.js";
import { useAction } from "../ui.js";

// A GitLab project's own access token: with one, ocra reads the project and
// posts its reviews as that token's bot instead of the server's. The token
// is sent once and never shown again; the page shows only the bot's name.

/** Why a token was refused: GitLab's verdict on it in the server's words, else the usual ones. */
function refusal(e: unknown): string {
  if (e instanceof ApiError) {
    const issue = e.issues[0];
    if (issue) return issue.message;
    if (e.code === "upstream_unreachable") return "GitLab did not answer; try again";
  }
  return why(e);
}

export function AccessToken(props: { r: AutoReviewRepoView; onChanged: () => void }) {
  const { r } = props;
  const path = `/auto-review/repos/${encodeURIComponent(r.id)}/access-token`;
  const [token, setToken] = useState("");
  const save = useAction(() =>
    api<RepoAccessTokenView>(path, { method: "PUT", body: JSON.stringify({ token }) }),
  );
  const clear = useAction(() => api<RepoAccessTokenView>(path, { method: "DELETE" }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await save.run()) === undefined) return;
    setToken("");
    props.onChanged();
  };
  const remove = async () => {
    if ((await clear.run()) !== undefined) props.onChanged();
  };
  return (
    <section className="repo-token stack" aria-label={`Access token of ${r.fullName}`}>
      <div className="strong">Project access token</div>
      <p className="muted small m-0">
        {r.hasAccessToken ? (
          <>
            ocra reads this project and posts its reviews as{" "}
            <span className="strong">{r.accessTokenBot}</span>, the bot of the token you gave.
          </>
        ) : (
          "ocra reads this project and posts its reviews as the server's bot. Give the project's own token, with the api scope and the Developer role, to post as the project's bot instead."
        )}
      </p>
      <form className="add-fields" onSubmit={submit}>
        <input
          className="input grow mono"
          type="password"
          autoComplete="off"
          aria-label={r.hasAccessToken ? "New project access token" : "Project access token"}
          placeholder={r.hasAccessToken ? "A new token replaces this one" : "glpat-…"}
          maxLength={512}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button type="submit" size="sm" loading={save.busy} disabled={!token.trim()}>
          {r.hasAccessToken ? "Replace" : "Save"}
        </Button>
        {r.hasAccessToken && (
          <Button
            type="button"
            variant="destructive-outline"
            size="sm"
            loading={clear.busy}
            onClick={remove}
          >
            Remove token
          </Button>
        )}
      </form>
      <span className="subtle small">
        The token is checked with GitLab, then never shown again.
      </span>
      {save.error !== null && (
        <p className="error m-0" role="alert">
          Could not save the token: {refusal(save.error)}.
        </p>
      )}
      {clear.error !== null && (
        <p className="error m-0" role="alert">
          Could not remove the token: {why(clear.error)}.
        </p>
      )}
    </section>
  );
}
